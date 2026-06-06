/* ===========================================================================
 * SignDeployer — landing page logic
 *  - Real sign-in (Supabase email magic link) + Stripe Checkout.
 *  - "Try the app" → public locked demo (app.html?demo=1), no account needed.
 *  - "Admin test" → code-gated full app (for the owner's testing).
 *  - Resumes checkout automatically after a magic-link login (?plan=...).
 * ========================================================================= */
(function () {
  const ADMIN_URL = 'app.html';

  const $ = (id) => document.getElementById(id);
  const modal = $('loginModal');

  const cfg = window.SIGNDEPLOYER_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-');
  const sb = configured && window.supabase
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;
  const ACTIVE = ['active', 'trialing'];
  const state = { user: null, active: false };
  let intendedPlan = null; // remembered when a logged-out user clicks a plan

  // ---- Try the app: public locked demo (no account) ----
  const demoEl = $('heroDemo');
  if (demoEl) demoEl.addEventListener('click', () => { location.href = ADMIN_URL + '?demo=1'; });

  // ---- Sign-in modal wiring ----
  if ($('footLogin')) $('footLogin').addEventListener('click', () => openLogin(null));
  if ($('modalClose')) $('modalClose').addEventListener('click', closeLogin);
  if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) closeLogin(); });
  if ($('loginForm')) $('loginForm').addEventListener('submit', onLoginSubmit);

  document.querySelectorAll('[data-plan]').forEach((btn) =>
    btn.addEventListener('click', () => onPlan(btn.dataset.plan))
  );

  // ---- pricing: monthly / yearly toggle (Individual plan) ----
  (function wireBillingToggle() {
    const monthly = $('billMonthly'), yearly = $('billYearly');
    const price = $('agentPrice'), cta = $('agentCta');
    if (!monthly || !yearly || !price || !cta) return;
    const apply = (period) => {
      const isMonthly = period === 'monthly';
      monthly.classList.toggle('active', isMonthly);
      yearly.classList.toggle('active', !isMonthly);
      price.innerHTML = isMonthly ? '$7<small>/month</small>' : '$49<small>/year</small>';
      cta.dataset.plan = isMonthly ? 'agent_monthly' : 'agent';
      cta.textContent = isMonthly ? 'Get started — $7/month' : 'Get started — $49/year';
      const note = document.getElementById('agentSaveNote');
      if (note) note.style.display = isMonthly ? 'none' : '';
    };
    monthly.addEventListener('click', () => apply('monthly'));
    yearly.addEventListener('click', () => apply('yearly'));
    apply('yearly');
  })();

  // ---- init / session ----
  init();
  async function init() {
    // navLogin always opens the modal until a session says otherwise.
    if ($('navLogin')) $('navLogin').addEventListener('click', () => onNavLogin());
    if (!sb) { console.info('[SignDeployer] Auth not configured — sign-in inert until Supabase keys are set.'); return; }
    const { data } = await sb.auth.getSession();
    await refresh(data.session?.user || null);

    // Returning from a magic-link login with a plan to resume? Start checkout.
    const plan = new URLSearchParams(location.search).get('plan');
    if (state.user && plan) {
      history.replaceState({}, '', location.pathname);
      return startCheckout(plan);
    }
    sb.auth.onAuthStateChange(async (_e, session) => { await refresh(session?.user || null); });
  }

  async function refresh(user) {
    state.user = user;
    state.active = user ? await isSubscribed(user) : false;
    updateNav();
  }

  async function isSubscribed(user) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    if (ACTIVE.includes(profile?.subscription_status)) return true;
    if (profile?.company_id) {
      const { data: company } = await sb
        .from('companies').select('subscription_status').eq('id', profile.company_id).maybeSingle();
      if (ACTIVE.includes(company?.subscription_status)) return true;
    }
    return false;
  }

  function updateNav() {
    const login = $('navLogin');
    if (!login) return;
    if (state.user && state.active) { login.textContent = 'Open app'; }
    else if (state.user) { login.textContent = 'Sign out'; }   // logged in but not subscribed
    else { login.textContent = 'Sign in'; }
  }
  async function onNavLogin() {
    if (state.user && state.active) return (location.href = '/app.html');
    if (state.user) {                                          // clear a stale/non-subscribed session
      if (sb) { try { await sb.auth.signOut(); } catch (e) {} }
      state.user = null; state.active = false; updateNav();
      return;
    }
    openLogin(null);
  }

  // ---- plan / checkout ----
  function onPlan(plan) {
    if (!sb) { openLogin(plan); return; } // not configured yet — still collect intent
    if (state.user && state.active) {
      // Already paying. Brokerage button → account page (upgrade/manage there);
      // agent button → straight into the app.
      return (location.href = plan === 'brokerage' ? '/account.html' : '/app.html');
    }
    if (state.user) return startCheckout(plan);
    openLogin(plan); // must sign in first; we resume checkout afterward
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
      else alert(data.error || 'Could not start checkout. Please try again.');
    } catch (e) {
      alert('Network error starting checkout. Check your connection and try again.');
    }
  }

  // ---- login modal ----
  function openLogin(planToResume) {
    intendedPlan = planToResume;
    $('modalTitle').textContent = planToResume ? 'Sign in to continue' : 'Sign in';
    $('modalSub').textContent = planToResume
      ? "Enter your email — we'll send a secure link, then take you to checkout."
      : "Enter your email and we'll send you a secure sign-in link.";
    $('loginMsg').textContent = '';
    if (modal) modal.style.display = 'flex';
    setTimeout(() => { const el = $('loginEmail'); if (el) el.focus(); }, 50);
  }
  function closeLogin() { if (modal) modal.style.display = 'none'; }

  async function onLoginSubmit(e) {
    e.preventDefault();
    const msg = $('loginMsg');
    if (!sb) { msg.textContent = 'Sign-in is not configured yet (Supabase keys missing).'; return; }
    const email = $('loginEmail').value.trim();
    const btn = $('loginSubmit');
    if (btn) btn.disabled = true;
    msg.textContent = 'Sending…';
    // Resuming a purchase? Return to the landing with ?plan=… so we launch
    // checkout. Otherwise go straight to the app.
    const redirect = intendedPlan
      ? `${location.origin}/?plan=${encodeURIComponent(intendedPlan)}`
      : `${location.origin}/app.html`;
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
    if (btn) btn.disabled = false;
    msg.textContent = error
      ? `Couldn't send link: ${error.message}`
      : '✓ Check your inbox for the sign-in link.';
  }
})();
