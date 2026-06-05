// POST /api/create-portal-session
// Returns: { url } — Stripe's self-serve billing portal (cancel, update card, invoices).
import { stripe, adminDb, getUser } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

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
  if (!customerId) return res.status(400).json({ error: 'No billing account yet' });

  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: appUrl,
  });

  return res.status(200).json({ url: session.url });
}
