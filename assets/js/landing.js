/* ===========================================================================
 * SignDeployer — landing page (DEMO MODE)
 *  - Sign-in & Stripe checkout are temporarily DISABLED.
 *  - The "Admin test" button drops straight into the app, bypassing Supabase
 *    auth and the paywall (handled in app-guard.js via ?admin=1).
 *  - The "Sign in" button opens a "coming soon" placeholder modal.
 *
 *  To re-enable real sign-in/billing later, restore the auth version of this
 *  file (Supabase magic link + checkout) and remove the admin bypass.
 * ========================================================================= */
(function () {
  const ADMIN_URL = 'app.html?admin=1';
  const $ = (id) => document.getElementById(id);
  const modal = $('loginModal');

  // --- Admin test: go straight into the app (bypasses login + payment) ---
  function gotoAdmin() {
    try { localStorage.setItem('sd_admin', '1'); } catch (e) {}
    location.href = ADMIN_URL;
  }
  ['navAdmin', 'heroAdmin', 'modalAdmin'].forEach((id) => {
    const el = $(id); if (el) el.addEventListener('click', gotoAdmin);
  });

  // --- Sign-in placeholder (disabled) ---
  function openLogin() { if (modal) modal.style.display = 'flex'; }
  function closeLogin() { if (modal) modal.style.display = 'none'; }
  ['navLogin', 'footLogin'].forEach((id) => {
    const el = $(id); if (el) el.addEventListener('click', openLogin);
  });
  if ($('modalClose')) $('modalClose').addEventListener('click', closeLogin);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeLogin(); });
  if ($('loginForm')) $('loginForm').addEventListener('submit', (e) => e.preventDefault());

  // --- Pricing buttons: checkout is off for now ---
  document.querySelectorAll('[data-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.plan === 'enterprise') {
        location.href = 'mailto:sales@signdeployer.com?subject=SignDeployer%20Enterprise%20inquiry';
      } else {
        openLogin(); // shows the "accounts & checkout coming soon" note
      }
    });
  });
})();
