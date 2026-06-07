// POST /api/stripe-webhook
// Stripe calls this after payments/renewals/cancellations. It updates the
// user's (or company's) subscription status in Supabase. This is the source
// of truth for "has this person paid?" — never trust the browser for that.
import { stripe, adminDb, json } from './lib/helpers.mjs';

export default async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  let event;
  try {
    // Netlify Functions 2.0 give us the raw body via req.text(), which Stripe
    // needs for signature verification.
    const body = await req.text();
    event = stripe.webhooks.constructEvent(
      body,
      req.headers.get('stripe-signature'),
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return new Response(`Webhook signature failed: ${err.message}`, { status: 400 });
  }

  const db = adminDb();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await applySubscription(db, sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        await applySubscription(db, event.data.object);
        break;
      }
      default:
        break; // Ignore event types we don't care about.
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return new Response('Handler error', { status: 500 });
  }

  return json({ received: true });
};

export const config = { path: '/api/stripe-webhook' };

// Write a Stripe subscription's state into our DB.
async function applySubscription(db, subInput) {
  // Re-fetch the latest subscription from Stripe so out-of-order webhook events
  // (e.g. a late "created/incomplete" arriving after "active") can't leave a
  // stale status. Stripe is the source of truth.
  let sub = subInput;
  try { if (subInput?.id) sub = await stripe.subscriptions.retrieve(subInput.id); } catch (_) { /* fall back to event payload */ }
  const meta = sub.metadata || {};
  let userId = meta.supabase_user_id;
  const plan = meta.plan || 'agent';
  const status = sub.status; // active | trialing | past_due | canceled | ...

  // Self-heal: if the subscription has no supabase_user_id (e.g. it was created
  // outside our checkout, or the metadata was lost), fall back to matching the
  // Stripe customer's email to a profile. Without this, a real payment can land
  // with no user attached and the buyer gets locked out despite paying.
  if (!userId) {
    try {
      const cust = await stripe.customers.retrieve(sub.customer);
      const email = cust && !cust.deleted ? cust.email : null;
      if (email) {
        const { data: prof } = await db
          .from('profiles').select('id').ilike('email', email).maybeSingle();
        if (prof?.id) userId = prof.id;
      }
    } catch (e) { console.error('Webhook: email fallback failed:', e.message); }
  }

  // current_period_end lives on the subscription in older Stripe API versions
  // and on the subscription ITEM in newer ones — read whichever is present.
  const rawEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end || null;
  const periodEnd = rawEnd ? new Date(rawEnd * 1000).toISOString() : null;

  // Brokerage and Enterprise are company plans (seats + branding).
  if (plan === 'brokerage' || plan === 'enterprise') {
    // Create/update the company, and mark the buyer as its owner.
    let { data: company } = await db
      .from('companies')
      .select('id')
      .eq('stripe_customer_id', sub.customer)
      .maybeSingle();

    if (!company) {
      const { data: created } = await db
        .from('companies')
        .insert({
          name: meta.company_name || 'My Company',
          contact_name: meta.contact_name || null,
          contact_email: meta.contact_email || null,
          contact_phone: meta.contact_phone || null,
          team_size: meta.team_size || null,
          owner_id: userId || null,
          stripe_customer_id: sub.customer,
          subscription_status: status,
          current_period_end: periodEnd,
        })
        .select('id')
        .single();
      company = created;
    } else {
      // Refresh billing state, and fill in any contact details newly provided
      // (e.g. on a re-checkout/upgrade) without wiping existing ones.
      const upd = { subscription_status: status, current_period_end: periodEnd };
      if (userId) upd.owner_id = userId; // backfill owner if an earlier run couldn't link it
      if (meta.company_name) upd.name = meta.company_name;
      if (meta.contact_name) upd.contact_name = meta.contact_name;
      if (meta.contact_email) upd.contact_email = meta.contact_email;
      if (meta.contact_phone) upd.contact_phone = meta.contact_phone;
      if (meta.team_size) upd.team_size = meta.team_size;
      await db.from('companies').update(upd).eq('id', company.id);
    }

    if (userId && company) {
      const profUpd = { plan, company_id: company.id, company_role: 'owner', subscription_status: status, current_period_end: periodEnd };
      if (meta.contact_name) profUpd.full_name = meta.contact_name;
      await db.from('profiles').update(profUpd).eq('id', userId);
    }

    // Upgrade cleanup: if this owner was previously on an individual plan, cancel
    // that old subscription on the same customer so they're not double-billed.
    if (status === 'active' || status === 'trialing') {
      try {
        const others = await stripe.subscriptions.list({ customer: sub.customer, status: 'active', limit: 20 });
        for (const s of others.data) {
          if (s.id !== sub.id) await stripe.subscriptions.cancel(s.id);
        }
      } catch (e) { console.error('Upgrade: could not cancel old subscription:', e.message); }
    }
    return;
  }

  // Individual "agent" plan.
  if (userId) {
    // Don't clobber a company membership (e.g. an old individual sub being
    // canceled right after the user upgraded to a brokerage).
    const { data: prof } = await db.from('profiles').select('company_id').eq('id', userId).maybeSingle();
    if (prof?.company_id) return;
    await db
      .from('profiles')
      .update({ plan: 'agent', subscription_status: status, current_period_end: periodEnd })
      .eq('id', userId);
  }
}
