// POST /api/accept-invite
// If the signed-in user's email has a pending company invite, attach them to
// that company (as a member) and consume the invite. This is how an EXISTING
// account joins a brokerage after being invited — brand-new signups are handled
// by the handle_new_user() trigger instead. Returns { attached: boolean }.
import { adminDb, getUser, ilikeExact, json } from './lib/helpers.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const db = adminDb();
  const email = (user.email || '').toLowerCase();
  if (!email) return json({ attached: false });

  // Already in a company? Nothing to claim.
  const { data: me } = await db
    .from('profiles').select('company_id').eq('id', user.id).maybeSingle();
  if (me?.company_id) return json({ attached: false, already: true });

  const { data: inv } = await db
    .from('company_invites').select('id, company_id')
    .ilike('email', ilikeExact(email)).order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (!inv) return json({ attached: false });

  await db.from('profiles')
    .update({ company_id: inv.company_id, company_role: 'member' })
    .eq('id', user.id);
  await db.from('company_invites').delete().eq('id', inv.id);

  return json({ attached: true, company_id: inv.company_id });
};

export const config = { path: '/api/accept-invite' };
