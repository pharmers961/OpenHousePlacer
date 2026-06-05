// POST /api/create-portal-session
// Returns: { url } — Stripe's self-serve billing portal (cancel, update card, invoices).
import { stripe, adminDb, getUser, appUrl, json } from './lib/helpers.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const db = adminDb();
  const { data: profile } = await db
    .from('profiles')
    .select('stripe_customer_id, company_id')
    .eq('id', user.id)
    .single();

  let customerId = profile?.stripe_customer_id;
  // Enterprise members manage billing through their company's customer.
  if (!customerId && profile?.company_id) {
    const { data: company } = await db
      .from('companies')
      .select('stripe_customer_id')
      .eq('id', profile.company_id)
      .single();
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
