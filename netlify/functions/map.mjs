// POST /api/map — authenticated proxy for every Mapbox API the app uses.
//
// WHY THIS EXISTS: the sign-placement tool used to call Mapbox straight from
// the browser with a public token, which meant (a) anyone could lift the token
// and burn our quota, and (b) the paywall was purely cosmetic — the whole tool
// worked with the gate script blocked. All Geocoding / Directions / Matrix /
// Tilequery / Optimization traffic now flows through here, using a SECRET
// server-side token (MAPBOX_TOKEN env var) that never reaches the browser.
// Only map TILE rendering still uses a public token in the client (mapbox-gl
// requires it); that token should be URL-restricted in the Mapbox dashboard
// and carries none of the expensive API traffic.
//
// Access rules:
//   - Signed-in user with an active subscription → allowed (per-user rate cap).
//   - Anonymous + { demo:true }                  → allowed ONLY for requests
//     whose coordinates stay near the fixed demo listing, with a per-IP rate
//     cap that fails CLOSED (a broken limiter must not open a free firehose).
//   - Anyone else → 401/403.
//
// Body: { kind, demo?, ...params } where kind ∈
//   suggest   { q }                — autocomplete (subscribers only)
//   geocode   { q }                — full geocode (subscribers only)
//   reverse   { lng, lat }         — reverse geocode
//   directions{ from:[lng,lat], to:[lng,lat] } — driving route with steps
//   matrix    { coords:[[lng,lat],...] }       — drive times from coords[0]
//   tilequery { lng, lat }         — road class at a point
//   optimize  { coords:[[lng,lat],...] }       — optimized trip order
// Returns the raw Mapbox JSON for that API.
import crypto from 'node:crypto';
import { adminDb, getUser, isActiveSubscriber, json, rateLimit, tooManyRequests } from './lib/helpers.mjs';

const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

// Keep in sync with DEMO_ADDR/DEMO_COORD in app.html.
const DEMO_CENTER = [-122.4327, 37.7762]; // 710 Steiner St, San Francisco
const DEMO_RADIUS_M = 30000; // generous: covers projected approach points at max drive time

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isCoord = (p) =>
  Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]) &&
  Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

function distM(a, b) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]), dLng = toRad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// The rate_limits table keys on a uuid; for anonymous demo callers we derive a
// stable uuid from the caller's IP so the same Postgres limiter covers them.
function ipBucketId(ip) {
  const h = crypto.createHash('sha256').update('sd-demo:' + ip).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Demo requests are fully deterministic (fixed listing → fixed bearings →
// fixed candidate points), so identical requests recur across every visitor.
// We cache each Mapbox response in the demo_cache table: after the first
// visitor warms a given (signs, drive-time) combination, demo searches cost
// ZERO Mapbox calls and return instantly.
function demoCacheKey(kind, body) {
  const parts = { kind };
  if (body.q != null) parts.q = body.q;
  if (body.lng != null) { parts.lng = body.lng; parts.lat = body.lat; }
  if (body.from) { parts.from = body.from; parts.to = body.to; }
  if (body.coords) parts.coords = body.coords;
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export default async (req, context) => {
  // GET → public client config: the URL-restricted tile token the browser
  // map renders with. Kept in an env var (NOT in the repo) so rotating it is
  // an env change, not a commit. This token is publishable by design; the
  // secret MAPBOX_TOKEN below is never returned here.
  if (req.method === 'GET') {
    return json({ glToken: process.env.MAPBOX_PUBLIC_TOKEN || '' });
  }
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!MAPBOX_TOKEN) return json({ error: 'Map service is not configured yet (missing MAPBOX_TOKEN).' }, 500);

  const body = await req.json().catch(() => ({}));
  const kind = String(body.kind || '');
  const db = adminDb();
  let cacheKey = null; // set for demo requests (see demoCacheKey)

  // --- Who is calling? ---
  const user = await getUser(req);
  let demo = false;
  if (user) {
    // Run the subscription check and the rate-limit check in parallel — they
    // are independent DB round trips, and this endpoint is on the hot path of
    // every search step.
    // ~600 calls ≈ 15–20 full searches per hour: ample for a working agent,
    // tight enough that a scripted scraper hits the wall fast.
    const [active, allowed] = await Promise.all([
      isActiveSubscriber(db, user.id),
      rateLimit(db, user.id, 'map', { max: 600, windowSec: 3600 }),
    ]);
    if (!active) return json({ error: 'An active subscription is required.' }, 403);
    if (!allowed) return tooManyRequests('Slow down a little — too many map requests in the last hour.');
  } else if (body.demo === true) {
    demo = true;
    if (kind === 'suggest' || kind === 'geocode') {
      return json({ error: 'Address search is not available in the demo.' }, 403);
    }
    // Cache first: a hit costs no Mapbox call and doesn't consume the
    // caller's rate budget. (Failures fall through to the live path.)
    cacheKey = demoCacheKey(kind, body);
    try {
      const { data: hit } = await db.from('demo_cache').select('response').eq('key', cacheKey).maybeSingle();
      if (hit?.response) return json(hit.response);
    } catch (_) { /* cache is best-effort */ }
    const ip = req.headers.get('x-nf-client-connection-ip') || context?.ip || '0.0.0.0';
    // failOpen:false — anonymous traffic must never bypass the cap.
    if (!(await rateLimit(db, ipBucketId(ip), 'map-demo', { max: 300, windowSec: 3600, failOpen: false })))
      return tooManyRequests('The demo is rate-limited — please try again in a little while.');
  } else {
    return json({ error: 'Not signed in' }, 401);
  }

  // Demo requests may only touch the area around the fixed demo listing.
  const inDemoArea = (pts) => !demo || pts.every((p) => distM(p, DEMO_CENTER) <= DEMO_RADIUS_M);
  const fmt = (p) => p[0] + ',' + p[1];

  let url;
  switch (kind) {
    case 'suggest':
    case 'geocode': {
      const q = String(body.q || '').trim().slice(0, 200);
      if (q.length < 2) return json({ error: 'Query too short.' }, 400);
      const opts = kind === 'suggest' ? 'autocomplete=true&limit=5&types=address,place' : 'limit=1';
      url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?${opts}&access_token=${MAPBOX_TOKEN}`;
      break;
    }
    case 'reverse': {
      const p = [body.lng, body.lat];
      if (!isCoord(p)) return json({ error: 'Invalid coordinates.' }, 400);
      if (!inDemoArea([p])) return json({ error: 'Outside the demo area.' }, 403);
      url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${fmt(p)}.json?types=address&limit=1&access_token=${MAPBOX_TOKEN}`;
      break;
    }
    case 'directions': {
      const { from, to } = body;
      if (!isCoord(from) || !isCoord(to)) return json({ error: 'Invalid coordinates.' }, 400);
      if (!inDemoArea([from, to])) return json({ error: 'Outside the demo area.' }, 403);
      url = `https://api.mapbox.com/directions/v5/mapbox/driving/${fmt(from)};${fmt(to)}?steps=true&geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;
      break;
    }
    case 'matrix': {
      const coords = body.coords;
      if (!Array.isArray(coords) || coords.length < 2 || coords.length > 25 || !coords.every(isCoord))
        return json({ error: 'Invalid coordinates.' }, 400);
      if (!inDemoArea(coords)) return json({ error: 'Outside the demo area.' }, 403);
      const destIdx = coords.slice(1).map((_, k) => k + 1).join(';');
      url = `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coords.map(fmt).join(';')}?sources=0&destinations=${destIdx}&annotations=duration&access_token=${MAPBOX_TOKEN}`;
      break;
    }
    case 'tilequery': {
      const p = [body.lng, body.lat];
      if (!isCoord(p)) return json({ error: 'Invalid coordinates.' }, 400);
      if (!inDemoArea([p])) return json({ error: 'Outside the demo area.' }, 403);
      url = `https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/tilequery/${fmt(p)}.json?radius=25&layers=road&limit=8&access_token=${MAPBOX_TOKEN}`;
      break;
    }
    case 'optimize': {
      const coords = body.coords;
      if (!Array.isArray(coords) || coords.length < 2 || coords.length > 12 || !coords.every(isCoord))
        return json({ error: 'Invalid coordinates.' }, 400);
      if (!inDemoArea(coords)) return json({ error: 'Outside the demo area.' }, 403);
      const radiuses = coords.map(() => 'unlimited').join(';');
      url = `https://api.mapbox.com/optimized-trips/v1/mapbox/driving/${coords.map(fmt).join(';')}?source=first&roundtrip=true&radiuses=${radiuses}&access_token=${MAPBOX_TOKEN}`;
      break;
    }
    default:
      return json({ error: 'Unknown request kind.' }, 400);
  }

  try {
    const r = await fetch(url);
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (data && (data.message || data.code)) || `Map provider error (${r.status}).`;
      return json({ error: msg }, r.status === 429 ? 429 : 502);
    }
    if (demo && cacheKey && data) {
      try { await db.from('demo_cache').upsert({ key: cacheKey, response: data }); }
      catch (_) { /* cache is best-effort */ }
    }
    return json(data);
  } catch (e) {
    console.error('map proxy error:', e);
    return json({ error: 'Map provider unreachable.' }, 502);
  }
};

export const config = { path: '/api/map' };
