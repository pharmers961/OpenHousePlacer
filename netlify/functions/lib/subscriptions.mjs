// Shared subscription → database logic.
// Used by BOTH the Stripe webhook (push) and /api/reconcile (pull, on demand),
// so however a payment reaches us, access is granted by the exact same rules.
import { stripe } from './helpers.mjs';

const ACTIVE = ['active', 'trialing'];

// Decide which plan a subscription is for. Prefer the explicit metadata we set
// at checkout; fall back to matching the price id so subscriptions created
// outside our flow (or with lost metadata) are still classified correctly.
function planFor(sub) {
  const meta = sub.metadata || {};
  if (meta.plan) return meta.plan;
  const priceId = sub.items?.data?.[0]?.price?.id || null;
  if (priceId && priceId === process.env.ENTERPRISE_PRICE_ID) return 'brokerage';
  return 'agent';
}

// Write a Stripe subscription's state into our DB. Idempotent: safe to call
// repeatedly (from webhooks AND reconcile) with the same subscription.
export async function applySubscription(db, subInput) {
  // Re-fetch the latest subscription from Stripe so out-of-order webhook events
  // (e.g. a late "created/incomplete" arriving after "active") can't leave a
  // stale status. Stripe is the source of truth.
  let sub = subInput;
  try { if (subInput?.id) sub = await stripe.subscriptions.retrieve(subInput.id); } catch (_) { /* fall back to event payload */ }
  const meta = sub.metadata || {};
  let userId = meta.supabase_user_id;
  const plan = planFor(sub);
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
    } catch (e) { console.error('applySubscription: email fallback failed:', e.message); }
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
    if (ACTIVE.includes(status)) {
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
