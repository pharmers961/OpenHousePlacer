// Shared helpers for the Netlify Functions (Stripe + Supabase).
// This lives in a subfolder so Netlify does NOT treat it as its own endpoint.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Admin client: bypasses Row Level Security. Server-only.
export function adminDb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

// Verify the caller's Supabase access token ("Authorization: Bearer ...").
export async function getUser(req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const { data, error } = await adminDb().auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// Find or create the Stripe customer for a profile, caching the id in the DB.
export async function ensureStripeCustomer(db, profile, user) {
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  });
  await db.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', user.id);
  return customer.id;
}

// Build the public site URL for Checkout redirects (no trailing slash).
export function appUrl(req) {
  const u = process.env.APP_URL || new URL(req.url).origin;
  return u.replace(/\/+$/, ''); // strip trailing slash(es) so we never build "…com//app.html"
}

// JSON response helper.
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Does this user have access (their own subscription OR their company's)?
// Single rule shared by every gated endpoint.
const ACTIVE_STATUSES = ['active', 'trialing'];
export async function isActiveSubscriber(db, userId) {
  const { data: profile } = await db
    .from('profiles').select('subscription_status, company_id').eq('id', userId).maybeSingle();
  if (ACTIVE_STATUSES.includes(profile?.subscription_status)) return true;
  if (profile?.company_id) {
    const { data: company } = await db
      .from('companies').select('subscription_status').eq('id', profile.company_id).maybeSingle();
    if (ACTIVE_STATUSES.includes(company?.subscription_status)) return true;
  }
  return false;
}

// Escape ILIKE wildcards in a value used as a pattern, so an email like
// "a%@evil.com" can only ever match itself (case-insensitively) and not act
// as a wildcard probe against other rows.
export function ilikeExact(value) {
  return String(value).replace(/([\\%_])/g, '\\$1');
}

// Per-user, per-endpoint rate limiting.
//
// These functions are stateless serverless invocations with no shared memory,
// so an in-process token bucket would reset on every cold start. Instead we keep
// the counter in Postgres (Supabase) and let a single SECURITY DEFINER function
// do an atomic check-and-increment inside a fixed window — see check_rate_limit()
// in supabase/schema.sql. Keyed by the authenticated user id (or an IP-derived
// id for the public demo), so the limit targets the actual caller rather than a
// shared IP.
//
//   const ok = await rateLimit(db, user.id, 'invite', { max: 15, windowSec: 3600 });
//   if (!ok) return tooManyRequests();
//
// failOpen (default true): if the limiter errors (DB hiccup, function not yet
// deployed), allow the request rather than lock out a paying customer.
// Endpoints that fan out to paid third-party APIs for ANONYMOUS callers (the
// demo) or amplify Stripe traffic should pass failOpen:false so a broken
// limiter can't be exploited to run up bills.
export async function rateLimit(db, userId, bucket, { max, windowSec, failOpen = true }) {
  if (!userId) return failOpen;
  try {
    const { data, error } = await db.rpc('check_rate_limit', {
      p_user_id: userId,
      p_bucket: bucket,
      p_max: max,
      p_window_seconds: windowSec,
    });
    if (error) { console.error('rateLimit error:', error.message); return failOpen; }
    return data === true;
  } catch (e) {
    console.error('rateLimit threw:', e.message);
    return failOpen;
  }
}

// Standard 429 response for a tripped rate limit.
export function tooManyRequests(message = 'Too many requests. Please wait a moment and try again.') {
  return json({ error: message }, 429);
}
