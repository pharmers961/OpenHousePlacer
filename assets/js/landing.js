/* ===========================================================================
 * SignDeployer — landing page logic
 *  - Login modal (Supabase email magic link)
 *  - "Get started" / plan buttons → Stripe Checkout (after login)
 *  - Resumes checkout automatically after a magic-link login (?plan=...)
 *  - Enterprise tier → contact sales
 * ========================================================================= */
(function () {
  // Where the Enterprise "Contact sales" button points. Change to your email
  // or a tel: link, e.g. 'tel:+15551234567'.
  const ENTERPRISE_CONTACT =
    'mailto:sales@signdeployer.com?subject=SignDeployer%20Enterprise%20inquiry';

  const cfg = window.SIGNDEPLOYER_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-');
  const sb = configured && window.supabase
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;
  const ACTIVE = ['active', 'trialing'];

  const state = { user: null, active: false };

  // ---- element refs ----
  const $ = (id) => document.getElementById(id);
  const modal = $('loginModal');

  // ---- wire buttons ----
  $('navLogin').addEventListener('click', () => openLogin(null));
  $('footLogin').addEventListener('click', () => openLogin(null));
  $('navStart').addEventListener('click', () => onStart());
  $('heroStart').addEventListener('click', () => onStart());
  $('modalClose').addEventListener('click', closeLogin);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeLogin(); });

  document.querySelectorAll('[data-plan]').forEach((btn) =>
    btn.addEventListener('click', () => onPlan(btn.dataset.plan))
  );

  $('loginForm').addEventListener('submit', onLoginSubmit);

  // ---- init / session ----
  let intendedPlan = null; // remembered when a logged-out user clicks a plan
  init();

  async function init() {
    if (!sb) { console.info('[SignDeployer] Auth not configured — buttons inert.'); return; }
    const { data } = await sb.auth.getSession();
    await refresh(data.session?.user || null);

    // Returning from a magic-link login with a plan to resume? Start checkout.
    const plan = new URLSearchParams(location.search).get('plan');
    if (state.user && plan) {
      history.replaceState({}, '', location.pathname);
      return startCheckout(plan);
    }

    sb.auth.onAuthStateChange(async (_e, session) => {
      await refresh(session?.user || null);
    });
  }

  async function refresh(user) {
    state.user = user;
    state.active = false;
    if (user) state.active = await isSubscribed(user);
    updateNav();
  }

  async function isSubscribed(user) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();
    if (ACTIVE.includes(profile?.subscription_status)) return true;
    if (profile?.company_id) {
      const { data: company } = await sb
        .from('companies').select('subscription_status').eq('id', profile.company_id).single();
      if (ACTIVE.includes(company?.subscription_status)) return true;
    }
    return false;
  }

  function updateNav() {
    const login = $('navLogin'), start = $('navStart');
    if (state.user && state.active) {
      login.textContent = 'Sign out';
      login.onclick = signOut;
      start.textContent = 'Open app';
      start.onclick = () => (location.href = '/app.html');
    } else if (state.user) {
      login.textContent = 'Sign out';
      login.onclick = signOut;
      start.textContent = 'Choose a plan';
      start.onclick = () => location.hash = '#pricing';
    } else {
      login.textContent = 'Log in';
      login.onclick = () => openLogin(null);
      start.textContent = 'Get started';
      start.onclick = onStart;
    }
  }

  // ---- actions ----
  function onStart() {
    if (state.user && state.active) return (location.href = '/app.html');
    location.hash = '#pricing';
  }

  function onPlan(plan) {
    if (plan === 'enterprise') { location.href = ENTERPRISE_CONTACT; return; }
    if (!sb) { alert('Sign-in is not configured yet.'); return; }
    if (state.user && state.active) return (location.href = '/app.html'); // already paying
    if (state.user) return startCheckout(plan);
    openLogin(plan); // must log in first; we resume checkout afterward
  }

  async function startCheckout(plan) {
    try {
      const token = (await sb.auth.getSession()).data.session?.access_token;
      const r = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan }),
      });
      const data = await r.json();
      if (data.url) location.href = data.url;
      else alert(data.error || 'Could not start checkout.');
    } catch (e) {
      alert('Network error starting checkout.');
    }
  }

  async function signOut() { await sb.auth.signOut(); location.reload(); }

  // ---- login modal ----
  function openLogin(planToResume) {
    intendedPlan = planToResume;
    $('modalTitle').textContent = planToResume ? 'Sign in to continue' : 'Log in';
    $('modalSub').textContent = planToResume
      ? "Enter your email — we'll send a secure link, then take you to checkout."
      : "Enter your email and we'll send you a secure sign-in link.";
    $('loginMsg').textContent = '';
    modal.style.display = 'flex';
    setTimeout(() => $('loginEmail').focus(), 50);
  }
  function closeLogin() { modal.style.display = 'none'; }

  async function onLoginSubmit(e) {
    e.preventDefault();
    if (!sb) return;
    const email = $('loginEmail').value.trim();
    const msg = $('loginMsg');
    msg.textContent = 'Sending…';
    // If resuming a purchase, come back to the landing page with ?plan=...
    // so we can launch checkout. Otherwise go straight to the app.
    const redirect = intendedPlan
      ? `${location.origin}/?plan=${encodeURIComponent(intendedPlan)}`
      : `${location.origin}/app.html`;
    const { error } = await sb.auth.signInWithOtp({
      email, options: { emailRedirectTo: redirect },
    });
    msg.textContent = error
      ? `Couldn't send link: ${error.message}`
      : '✓ Check your inbox for the sign-in link.';
  }
})();
