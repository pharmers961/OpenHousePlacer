// POST /api/reconcile
// Safety net for missed/delayed Stripe webhooks. The app gate calls this when a
// signed-in user looks UNPAID — we ask Stripe directly whether they have an
// active subscription and, if so, repair the database so they get access.
// Stripe is the source of truth; this means a webhook failing or never firing
// can no longer leave a paying customer locked out.
import { stripe, adminDb, getUser, json, rateLimit, tooManyRequests } from './lib/helpers.mjs';
import { applySubscription } from './lib/subscriptions.mjs';

const ACTIVE = ['active', 'trialing'];

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 401);

  const user = await getUser(req);
  if (!user) return json({ error: 'Not signed in' }, 401);

  const db = adminDb();

  // Each call fans out to the Stripe API (customers.list + subscriptions.list),
  // and the app gate triggers this automatically when a user looks unpaid, so
  // it's the hottest path here. Throttle per user so spamming it can't burn
  // through our account-wide Stripe rate budget and starve real traffic. The
  // window is generous enough for the legitimate "I just paid, let me in" retry.
  // failOpen:false — this endpoint amplifies into multiple Stripe API calls, so
  // a broken limiter must not let it run unthrottled.
  if (!(await rateLimit(db, user.id, 'reconcile', { max: 8, windowSec: 60, failOpen: false })))
    return tooManyRequests('Still checking your subscription — please wait a moment and refresh.');

  try {
    const { data: profile } = await db
      .from('profiles').select('stripe_customer_id, company_id').eq('id', user.id).maybeSingle();

    // Find this user's Stripe customer(s): the cached id, plus any customer that
    // shares their email (covers payments made before the id was cached).
    const customerIds = new Set();
    if (profile?.stripe_customer_id) customerIds.add(profile.stripe_customer_id);
    if (user.email) {
      try {
        const list = await stripe.customers.list({ email: user.email, limit: 10 });
        list.data.forEach((c) => customerIds.add(c.id));
      } catch (_) {}
    }

    // Apply the best subscription we can find (an active one if present).
    for (const customerId of customerIds) {
      let subs;
      try { subs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 20 }); }
      catch (_) { continue; }
      const target = subs.data.find((s) => ACTIVE.includes(s.status)) || subs.data[0];
      if (target) await applySubscription(db, target);
    }

    // Re-read access after any repair, using the same rule as the gate.
    const { data: prof } = await db
      .from('profiles').select('subscription_status, company_id').eq('id', user.id).maybeSingle();
    let active = ACTIVE.includes(prof?.subscription_status);
    if (!active && prof?.company_id) {
      const { data: company } = await db
        .from('companies').select('subscription_status').eq('id', prof.company_id).maybeSingle();
      active = ACTIVE.includes(company?.subscription_status);
    }
    return json({ active });
  } catch (e) {
    console.error('reconcile error:', e);
    // Never hard-fail the gate on our account: just report "not active".
    return json({ active: false });
  }
};

export const config = { path: '/api/reconcile' };
