// Shared helpers for the serverless API routes.
// Files in /api starting with "_" are NOT exposed as routes by Vercel.
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Admin client: bypasses Row Level Security. Use ONLY on the server.
export function adminDb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

// Verify the caller's Supabase access token (sent as "Authorization: Bearer ...")
// and return the authenticated user, or null.
export async function getUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

// Find or create the Stripe customer for a profile, caching the id back to the DB.
export async function ensureStripeCustomer(db, profile, user) {
  if (profile?.stripe_customer_id) return profile.stripe_customer_id;
  const customer = await stripe.customers.create({
    email: user.email,
    metadata: { supabase_user_id: user.id },
  });
  await db.from('profiles').update({ stripe_customer_id: customer.id }).eq('id', user.id);
  return customer.id;
}

export function readJson(req) {
  // Vercel parses JSON bodies by default; fall back to manual parse just in case.
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
