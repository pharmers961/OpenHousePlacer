// POST /api/stripe-webhook
// Stripe calls this after payments/renewals/cancellations. It updates the
// user's (or company's) subscription status in Supabase. This is the source
// of truth for "has this person paid?" — never trust the browser for that.
//
// NOTE: the actual DB write lives in lib/subscriptions.mjs so the on-demand
// /api/reconcile endpoint can apply the exact same rules if a webhook is ever
// missed or delayed.
import { stripe, adminDb, json } from './lib/helpers.mjs';
import { applySubscription } from './lib/subscriptions.mjs';

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
