// POST /api/create-checkout-session
// Body: { plan: "agent" | "enterprise", companyName?: string }
// Returns: { url } — a Stripe Checkout page to redirect the agent to.
import { stripe, adminDb, getUser, ensureStripeCustomer, readJson } from './_lib.js';

const PRICE_BY_PLAN = {
  agent: () => process.env.AGENT_PRICE_ID,
  enterprise: () => process.env.ENTERPRISE_PRICE_ID,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const { plan, companyName } = readJson(req);
  const priceFn = PRICE_BY_PLAN[plan];
  if (!priceFn) return res.status(400).json({ error: 'Unknown plan' });
  const price = priceFn();
  if (!price) return res.status(500).json({ error: `Price for "${plan}" is not configured` });

  const db = adminDb();
  const { data: profile } = await db.from('profiles').select('*').eq('id', user.id).single();
  const customerId = await ensureStripeCustomer(db, profile, user);

  const appUrl = process.env.APP_URL || `https://${req.headers.host}`;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${appUrl}/?checkout=success`,
    cancel_url: `${appUrl}/?checkout=cancelled`,
    // Carried through to the webhook so we know who paid and for what.
    subscription_data: {
      metadata: { supabase_user_id: user.id, plan, company_name: companyName || '' },
    },
    metadata: { supabase_user_id: user.id, plan, company_name: companyName || '' },
  });

  return res.status(200).json({ url: session.url });
}
