/* ---------------------------------------------------------------------------
 * PUBLIC config — safe to commit. These are publishable values, not secrets.
 *
 * IMPORTANT: Until you replace the two "YOUR-..." placeholders below, the
 * paywall stays OFF and SignDeployer runs exactly as it does today. The moment
 * real Supabase values are present, login + the paywall switch on.
 * ------------------------------------------------------------------------- */
window.SIGNDEPLOYER_CONFIG = {
  // Supabase → Project Settings → API
  SUPABASE_URL: 'https://bzpmthgktbmbxiqkufmh.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_uEqnw-_V18C0cfdQ8h6Dow_9b5gtoOu',

  // Display-only price labels shown on the paywall. The REAL prices live in
  // Stripe and are enforced by the server — changing these can't grant access.
  AGENT_PRICE_LABEL: '$19.99 / year',
  ENTERPRISE_PRICE_LABEL: '$499 / year',
};
