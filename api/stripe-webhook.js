// POST /api/stripe-webhook
// Stripe calls this after payments/renewals/cancellations. It updates the
// user's (or company's) subscription status in Supabase. This is the source
// of truth for "has this person paid?" — never trust the browser for that.
import { stripe, adminDb } from './_lib.js';

// Stripe signature verification needs the RAW body, so turn off Vercel's parser.
export const config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const buf = await rawBody(req);
    event = stripe.webhooks.constructEvent(
      buf,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook signature failed: ${err.message}`);
  }

  const db = adminDb();

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // Grab the full subscription so we know the plan + period end.
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
        // Ignore the many event types we don't care about.
        break;
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
    return res.status(500).send('Handler error');
  }

  return res.status(200).json({ received: true });
}

// Write a Stripe subscription's state into our DB.
async function applySubscription(db, sub) {
  const meta = sub.metadata || {};
  const userId = meta.supabase_user_id;
  const plan = meta.plan || 'agent';
  const status = sub.status; // active | trialing | past_due | canceled | ...
  const periodEnd = sub.current_period_end
    ? new Date(sub.current_period_end * 1000).toISOString()
    : null;

  if (plan === 'enterprise') {
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
        .update({ plan: 'enterprise', company_id: company.id, company_role: 'owner' })
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
