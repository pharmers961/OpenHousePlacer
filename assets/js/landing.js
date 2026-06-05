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
  const ADMIN_URL = 'app.html';
  const $ = (id) => document.getElementById(id);
  const modal = $('loginModal');

  // --- Admin test: prompt for the access code, then enter the app ---
  // We compare a hash so the code itself isn't sitting in the page source.
  const ADMIN_CODE_HASH = 4059872811;
  function codeHash(s) { s = String(s); let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h |= 0; } return h >>> 0; }
  function gotoAdmin() {
    const code = prompt('Enter admin access code:');
    if (code == null) return; // cancelled
    if (codeHash(code.trim()) !== ADMIN_CODE_HASH) { alert('Incorrect access code.'); return; }
    location.href = ADMIN_URL + '?admin=' + encodeURIComponent(code.trim());
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
