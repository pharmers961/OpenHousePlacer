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
async function applySubscription(db, sub) {
  const meta = sub.metadata || {};
  const userId = meta.supabase_user_id;
  const plan = meta.plan || 'agent';
  const status = sub.status; // active | trialing | past_due | canceled | ...
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

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
          owner_id: userId || null,
          stripe_customer_id: sub.customer,
          subscription_status: status,
          current_period_end: periodEnd,
        })
        .select('id')
        .single();
      company = created;
    } else {
      await db
        .from('companies')
        .update({ subscription_status: status, current_period_end: periodEnd })
        .eq('id', company.id);
    }

    if (userId && company) {
      await db
        .from('profiles')
        .update({ plan, company_id: company.id, company_role: 'owner' })
        .eq('id', userId);
    }
    return;
  }

  // Individual "agent" plan.
  if (userId) {
    await db
      .from('profiles')
      .update({ plan: 'agent', subscription_status: status, current_period_end: periodEnd })
      .eq('id', userId);
  }
}
