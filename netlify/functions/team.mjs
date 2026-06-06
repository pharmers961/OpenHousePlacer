// /api/team — Brokerage team management + branding (owner only).
//   GET                         → { company, members[], invites[], seats:{used,cap} }
//   POST { email }              → invite/attach an agent (enforces seat cap)
//   POST { branding:{name,brand_color,logo_url} } → update the company's branding
//   DELETE { id, kind }         → remove a member (kind:'member') or revoke an invite (kind:'invite')
//
// A member who already has an account is attached immediately; an unknown email
// becomes a pending invite that handle_new_user() consumes when they sign up.
import { adminDb, getUser, json } from './lib/helpers.mjs';

const BROKERAGE_CAP = 50;       // Brokerage plan seats
const ENTERPRISE_CAP = 100000;  // effectively unlimited

export default async (req) => {
  const user = await getUser(req);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const db = adminDb();
  const { data: me } = await db
    .from('profiles').select('company_id, company_role, plan').eq('id', user.id).maybeSingle();

  if (!me?.company_id) return json({ error: 'No brokerage on this account.' }, 400);
  if (me.company_role !== 'owner') return json({ error: 'Only the brokerage owner can manage the team.' }, 403);

  const companyId = me.company_id;
  const cap = me.plan === 'enterprise' ? ENTERPRISE_CAP : BROKERAGE_CAP;

  async function snapshot() {
    const { data: company } = await db
      .from('companies').select('id, name, brand_color, logo_url, subscription_status').eq('id', companyId).maybeSingle();
    const { data: members } = await db
      .from('profiles').select('id, email, full_name, company_role')
      .eq('company_id', companyId).order('created_at', { ascending: true });
    const { data: invites } = await db
      .from('company_invites').select('id, email, created_at')
      .eq('company_id', companyId).order('created_at', { ascending: true });
    const used = (members?.length || 0) + (invites?.length || 0);
    return { company, members: members || [], invites: invites || [], seats: { used, cap } };
  }

  try {
    if (req.method === 'GET') return json(await snapshot());

    if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));

      // --- Branding update ---
      if (body.branding) {
        const b = body.branding, upd = {};
        if (typeof b.name === 'string') upd.name = (b.name.trim().slice(0, 80)) || 'My Company';
        if (typeof b.brand_color === 'string' && b.brand_color.trim()) {
          const c = b.brand_color.trim();
          if (!/^#?[0-9a-fA-F]{6}$/.test(c)) return json({ error: 'Brand color must be a 6-digit hex, e.g. #0a0a0a.' }, 400);
          upd.brand_color = c[0] === '#' ? c : ('#' + c);
        }
        if (typeof b.logo_url === 'string') {
          const u = b.logo_url.trim();
          if (u && !/^https:\/\//i.test(u)) return json({ error: 'Logo URL must start with https://' }, 400);
          upd.logo_url = u || null;
        }
        if (Object.keys(upd).length) await db.from('companies').update(upd).eq('id', companyId);
        return json({ ok: true, ...(await snapshot()) });
      }

      // --- Invite agent ---
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: 'Enter a valid email address.' }, 400);

      const snap = await snapshot();
      if (snap.seats.used >= snap.seats.cap)
        return json({ error: `All ${snap.seats.cap} seats are in use. Remove a member to add another.` }, 409);
      if (snap.members.some((m) => (m.email || '').toLowerCase() === email))
        return json({ error: 'That agent is already on your team.' }, 409);

      const { data: existing } = await db
        .from('profiles').select('id, company_id').ilike('email', email).maybeSingle();

      if (existing) {
        if (existing.company_id && existing.company_id !== companyId)
          return json({ error: 'That agent already belongs to another brokerage.' }, 409);
        await db.from('profiles')
          .update({ company_id: companyId, company_role: 'member' }).eq('id', existing.id);
        return json({ ok: true, attached: true, ...(await snapshot()) });
      }

      await db.from('company_invites')
        .upsert({ company_id: companyId, email, invited_by: user.id }, { onConflict: 'company_id,email' });
      return json({ ok: true, invited: true, ...(await snapshot()) });
    }

    if (req.method === 'DELETE') {
      const body = await req.json().catch(() => ({}));
      const { id, kind } = body;
      if (!id) return json({ error: 'Missing id.' }, 400);
      if (kind === 'invite') {
        await db.from('company_invites').delete().eq('id', id).eq('company_id', companyId);
      } else {
        if (id === user.id) return json({ error: "You can't remove yourself (the owner)." }, 400);
        await db.from('profiles')
          .update({ company_id: null, company_role: 'member' })
          .eq('id', id).eq('company_id', companyId);
      }
      return json({ ok: true, ...(await snapshot()) });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    return json({ error: e.message || 'Team update failed.' }, 500);
  }
};

export const config = { path: '/api/team' };
