// POST /api/create-checkout-session
// Body: { plan: "agent" | "enterprise", companyName?: string }
// Returns: { url } — a Stripe Checkout page to redirect the agent to.
import { stripe, adminDb, getUser, ensureStripeCustomer, appUrl, json } from './lib/helpers.mjs';

const PRICE_BY_PLAN = {
  agent: () => process.env.AGENT_PRICE_ID,            // Individual — $20/yr, 1 seat
  brokerage: () => process.env.ENTERPRISE_PRICE_ID,   // Small Brokerage — $499/yr, up to 25 seats
  enterprise: () => process.env.ENTERPRISE_PRICE_ID,  // (alias; the public Enterprise tier is contact-sales)
};

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await getUser(req);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const { plan, companyName } = await req.json().catch(() => ({}));
  const priceFn = PRICE_BY_PLAN[plan];
  if (!priceFn) return json({ error: 'Unknown plan' }, 400);
  const price = priceFn();
  if (!price) return json({ error: `Price for "${plan}" is not configured` }, 500);

  const db = adminDb();
  const { data: profile } = await db.from('profiles').select('*').eq('id', user.id).single();
  const customerId = await ensureStripeCustomer(db, profile, user);

  const base = appUrl(req);
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${base}/app.html?checkout=success`,
    cancel_url: `${base}/#pricing`,
    // Carried through to the webhook so we know who paid and for what.
    subscription_data: {
      metadata: { supabase_user_id: user.id, plan, company_name: companyName || '' },
    },
    metadata: { supabase_user_id: user.id, plan, company_name: companyName || '' },
  });

  return json({ url: session.url });
};

export const config = { path: '/api/create-checkout-session' };
