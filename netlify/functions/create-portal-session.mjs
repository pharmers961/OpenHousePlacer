// POST /api/create-portal-session
// Returns: { url } — Stripe's self-serve billing portal (cancel, update card, invoices).
import { stripe, adminDb, getUser, appUrl, json, rateLimit, tooManyRequests } from './lib/helpers.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const db = adminDb();

  // Each call creates a Stripe billing-portal session; cap per user.
  if (!(await rateLimit(db, user.id, 'portal', { max: 10, windowSec: 600 })))
    return tooManyRequests();

  const { data: profile } = await db
    .from('profiles')
    .select('stripe_customer_id, company_id, company_role')
    .eq('id', user.id)
    .maybeSingle();

  let customerId = profile?.stripe_customer_id;
  // Company billing is managed ONLY by the owner — a regular member must not be
  // able to open the portal and cancel/modify the whole brokerage's plan.
  if (!customerId && profile?.company_id) {
    if (profile.company_role !== 'owner') {
      return json({ error: 'Only the brokerage owner can manage billing.' }, 403);
    }
    const { data: company } = await db
      .from('companies')
      .select('stripe_customer_id')
      .eq('id', profile.company_id)
      .maybeSingle();
    customerId = company?.stripe_customer_id;
  }
  if (!customerId) return json({ error: 'No billing account yet' }, 400);

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: appUrl(req),
  });

  return json({ url: session.url });
};

export const config = { path: '/api/create-portal-session' };
