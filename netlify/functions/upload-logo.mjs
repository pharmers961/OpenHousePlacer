// POST /api/upload-logo
// Owner-only brokerage logo upload. Writes to the public "branding" bucket
// using the service-role key, so it does NOT depend on Storage RLS policies
// being configured in the project (which is fragile to set up by hand).
// Body: { filename, contentType, dataBase64 }   Returns: { url }
import { adminDb, getUser, json } from './lib/helpers.mjs';

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const db = adminDb();
  const { data: me } = await db
    .from('profiles').select('company_id, company_role').eq('id', user.id).maybeSingle();
  if (!me?.company_id) return json({ error: 'No brokerage on this account.' }, 400);
  if (me.company_role !== 'owner') return json({ error: 'Only the brokerage owner can change branding.' }, 403);

  const { filename, contentType, dataBase64 } = await req.json().catch(() => ({}));
  if (!dataBase64) return json({ error: 'No file data received.' }, 400);

  // Resolve the extension/mime from the content type, falling back to the
  // filename extension (some browsers send an empty type for SVG).
  let ext = EXT_BY_MIME[contentType];
  if (!ext && filename) ext = ({ png: 'png', jpg: 'jpg', jpeg: 'jpg', webp: 'webp', svg: 'svg' })[(filename.split('.').pop() || '').toLowerCase()];
  if (!ext) return json({ error: 'Use a PNG, JPG, SVG, or WebP image.' }, 400);
  const mime = EXT_BY_MIME[contentType] ? contentType : MIME[ext];

  let buf;
  try { buf = Buffer.from(dataBase64, 'base64'); } catch { return json({ error: 'Invalid file data.' }, 400); }
  if (!buf.length || buf.length > MAX_BYTES) return json({ error: 'Image must be under 2 MB.' }, 400);

  const path = `${me.company_id}/logo-${Date.now()}.${ext}`;

  // Best-effort: ensure the public bucket exists (no-op if it already does).
  try {
    await db.storage.createBucket('branding', {
      public: true,
      fileSizeLimit: MAX_BYTES,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'],
    });
  } catch (_) { /* already exists */ }

  const { error: upErr } = await db.storage
    .from('branding')
    .upload(path, buf, { contentType: mime, upsert: true });
  if (upErr) return json({ error: upErr.message || 'Upload failed.' }, 500);

  const { data } = db.storage.from('branding').getPublicUrl(path);
  return json({ url: data.publicUrl });
};

export const config = { path: '/api/upload-logo' };
