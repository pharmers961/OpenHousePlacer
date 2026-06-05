/* ===========================================================================
 * SignDeployer — login + paywall + Enterprise branding (client side)
 *
 * Activates ONLY when assets/js/config.js holds real Supabase values.
 * Until then this file no-ops and the app behaves exactly as before.
 *
 * Security note: this is the customer-facing gate. Renewals, cancellations
 * and "who has paid" are enforced server-side (Stripe webhook → database).
 * The browser is never the source of truth for payment.
 * ========================================================================= */
(function () {
  const cfg = window.SIGNDEPLOYER_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_ANON_KEY.includes('YOUR-');

  if (!configured) {
    console.info('[SignDeployer] Paywall not configured yet — running in open mode.');
    return;
  }
  if (!window.supabase) {
    console.error('[SignDeployer] Supabase library not loaded.');
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const ACTIVE = ['active', 'trialing'];

  injectStyles();
  const ui = buildOverlay();
  document.body.appendChild(ui.overlay);

  let currentUser = null;

  init();

  async function init() {
    const { data } = await sb.auth.getSession();
    currentUser = data.session?.user || null;
    await route();
    sb.auth.onAuthStateChange(async (_e, session) => {
      currentUser = session?.user || null;
      await route();
    });
  }

  // Decide which screen to show.
  async function route() {
    if (!currentUser) return showSignedOut();

    showLoading('Checking your subscription…');
    let access = await loadAccess();

    // Just returned from a successful Checkout? The webhook may lag a moment.
    if (!access.active && new URLSearchParams(location.search).get('checkout') === 'success') {
      for (let i = 0; i < 6 && !access.active; i++) {
        await sleep(1500);
        access = await loadAccess();
      }
    }

    if (access.active) return grantAccess(access);
    return showPaywall();
  }

  // Read this user's profile (and their company, for Enterprise).
  async function loadAccess() {
    const { data: profile } = await sb
      .from('profiles')
      .select('*')
      .eq('id', currentUser.id)
      .single();

    let branding = null;
    let active = ACTIVE.includes(profile?.subscription_status);

    if (profile?.company_id) {
      const { data: company } = await sb
        .from('companies')
        .select('*')
        .eq('id', profile.company_id)
        .single();
      if (company) {
        active = active || ACTIVE.includes(company.subscription_status);
        branding = company;
      }
    }
    return { profile, branding, active };
  }

  /* ---------------- screens ---------------- */

  function showLoading(msg) {
    ui.overlay.style.display = 'flex';
    ui.body.innerHTML = `<div class="ss-spin"></div><p class="ss-muted">${msg || 'Loading…'}</p>`;
    ui.foot.innerHTML = '';
  }

  function showSignedOut() {
    ui.overlay.style.display = 'flex';
    ui.body.innerHTML = `
      <h2 class="ss-h">Sign in to SignDeployer</h2>
      <p class="ss-muted">Enter your email and we'll send you a secure sign-in link.</p>
      <form id="ss-login">
        <input id="ss-email" type="email" required placeholder="you@brokerage.com" />
        <button class="ss-btn ss-primary" type="submit">Email me a sign-in link</button>
      </form>
      <p id="ss-login-msg" class="ss-muted"></p>`;
    ui.foot.innerHTML = '';
    document.getElementById('ss-login').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('ss-email').value.trim();
      const msg = document.getElementById('ss-login-msg');
      msg.textContent = 'Sending…';
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: location.origin },
      });
      msg.textContent = error
        ? `Couldn't send link: ${error.message}`
        : '✓ Check your inbox for the sign-in link.';
    });
  }

  function showPaywall() {
    ui.overlay.style.display = 'flex';
    ui.body.innerHTML = `
      <h2 class="ss-h">Choose your plan</h2>
      <p class="ss-muted">Signed in as ${escapeHtml(currentUser.email)}.</p>
      <div class="ss-plans">
        <div class="ss-plan">
          <div class="ss-plan-name">Agent</div>
          <div class="ss-plan-price">${escapeHtml(cfg.AGENT_PRICE_LABEL || '')}</div>
          <ul><li>Full sign-placement tool</li><li>One agent</li><li>Cancel anytime</li></ul>
          <button class="ss-btn ss-primary" data-plan="agent">Subscribe</button>
        </div>
        <div class="ss-plan ss-plan-ent">
          <div class="ss-plan-name">Enterprise</div>
          <div class="ss-plan-price">${escapeHtml(cfg.ENTERPRISE_PRICE_LABEL || '')}</div>
          <ul><li>Unlimited agents</li><li>Your company branding</li><li>Priority support</li></ul>
          <input id="ss-company" type="text" placeholder="Company name" />
          <button class="ss-btn" data-plan="enterprise">Subscribe</button>
        </div>
      </div>
      <p id="ss-pay-msg" class="ss-muted"></p>`;
    ui.foot.innerHTML = `<button class="ss-link" id="ss-signout">Sign out</button>`;

    ui.body.querySelectorAll('[data-plan]').forEach((btn) =>
      btn.addEventListener('click', () => startCheckout(btn.dataset.plan))
    );
    document.getElementById('ss-signout').addEventListener('click', signOut);
  }

  function grantAccess(access) {
    ui.overlay.style.display = 'none';
    applyBranding(access.branding);
    mountAccountChip(access);
    // Clean the ?checkout= param out of the URL.
    if (location.search.includes('checkout=')) {
      history.replaceState({}, '', location.pathname);
    }
  }

  /* ---------------- actions ---------------- */

  async function startCheckout(plan) {
    const msg = document.getElementById('ss-pay-msg');
    msg.textContent = 'Redirecting to secure checkout…';
    const companyName = document.getElementById('ss-company')?.value?.trim() || '';
    const token = (await sb.auth.getSession()).data.session?.access_token;
    try {
      const r = await fetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan, companyName }),
      });
      const data = await r.json();
      if (data.url) location.href = data.url;
      else msg.textContent = data.error || 'Could not start checkout.';
    } catch (err) {
      msg.textContent = 'Network error starting checkout.';
    }
  }

  async function manageBilling() {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const r = await fetch('/api/create-portal-session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (data.url) location.href = data.url;
  }

  async function signOut() {
    await sb.auth.signOut();
  }

  /* ---------------- Enterprise branding ---------------- */

  function applyBranding(company) {
    if (!company) return;
    const logo = document.getElementById('brandLogo');
    if (company.logo_url && logo) logo.src = company.logo_url;
    if (company.name) {
      const sub = document.querySelector('.brand p');
      if (sub) sub.textContent = company.name;
      if (logo) logo.alt = company.name;
    }
    if (company.brand_color) {
      document.documentElement.style.setProperty('--ink', company.brand_color);
    }
  }

  function mountAccountChip(access) {
    const chip = document.createElement('div');
    chip.className = 'ss-chip';
    const planLabel = access.branding ? 'Enterprise' : 'Agent';
    chip.innerHTML = `
      <span>${escapeHtml(currentUser.email)} · ${planLabel}</span>
      <button class="ss-link" id="ss-billing">Billing</button>
      <button class="ss-link" id="ss-signout2">Sign out</button>`;
    document.body.appendChild(chip);
    document.getElementById('ss-billing').addEventListener('click', manageBilling);
    document.getElementById('ss-signout2').addEventListener('click', signOut);
  }

  /* ---------------- helpers / styles ---------------- */

  function buildOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'ss-overlay';
    const card = document.createElement('div');
    card.className = 'ss-card';
    const logo = document.createElement('div');
    logo.className = 'ss-brand';
    logo.textContent = 'SignDeployer';
    const body = document.createElement('div');
    body.className = 'ss-cardbody';
    const foot = document.createElement('div');
    foot.className = 'ss-cardfoot';
    card.append(logo, body, foot);
    overlay.appendChild(card);
    return { overlay, body, foot };
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function injectStyles() {
    const css = `
    .ss-overlay{position:fixed;inset:0;z-index:9999;display:none;align-items:center;
      justify-content:center;background:rgba(10,10,10,.55);backdrop-filter:blur(4px);
      font-family:'Montserrat',system-ui,sans-serif;padding:20px;}
    .ss-card{background:#fff;width:100%;max-width:560px;border-radius:8px;overflow:hidden;
      box-shadow:0 20px 60px rgba(0,0,0,.3);}
    .ss-brand{background:#0a0a0a;color:#fff;padding:18px 26px;font-weight:700;
      letter-spacing:3px;text-transform:uppercase;font-size:18px;}
    .ss-cardbody{padding:26px;}
    .ss-cardfoot{padding:0 26px 22px;}
    .ss-h{margin:0 0 6px;font-size:20px;font-weight:600;color:#0a0a0a;}
    .ss-muted{color:#666;font-size:13px;margin:6px 0;}
    .ss-card input{width:100%;padding:12px;margin:8px 0;border:1px solid #ddd;border-radius:4px;
      font:inherit;box-sizing:border-box;}
    .ss-btn{display:inline-block;width:100%;padding:13px;border:1px solid #0a0a0a;background:#fff;
      color:#0a0a0a;font:inherit;font-weight:600;letter-spacing:1px;text-transform:uppercase;
      font-size:12px;border-radius:3px;cursor:pointer;margin-top:8px;}
    .ss-primary{background:#0a0a0a;color:#fff;}
    .ss-link{background:none;border:none;color:#666;text-decoration:underline;cursor:pointer;
      font:inherit;font-size:12px;padding:4px 8px;}
    .ss-plans{display:flex;gap:14px;margin:14px 0;flex-wrap:wrap;}
    .ss-plan{flex:1;min-width:200px;border:1px solid #e6e6e6;border-radius:6px;padding:18px;}
    .ss-plan-ent{border-color:#0a0a0a;}
    .ss-plan-name{font-weight:700;text-transform:uppercase;letter-spacing:2px;font-size:13px;}
    .ss-plan-price{font-size:22px;font-weight:700;color:#0a0a0a;margin:6px 0;}
    .ss-plan ul{margin:10px 0;padding-left:18px;color:#555;font-size:13px;}
    .ss-plan li{margin:4px 0;}
    .ss-spin{width:26px;height:26px;border:3px solid #eee;border-top-color:#0a0a0a;
      border-radius:50%;animation:ss-rot .8s linear infinite;margin:8px auto;}
    @keyframes ss-rot{to{transform:rotate(360deg)}}
    .ss-chip{position:fixed;top:12px;right:12px;z-index:9998;background:rgba(255,255,255,.96);
      border:1px solid #e6e6e6;border-radius:20px;padding:6px 10px;display:flex;align-items:center;
      gap:6px;font-family:'Montserrat',sans-serif;font-size:12px;color:#333;
      box-shadow:0 4px 14px rgba(0,0,0,.12);}
    @media (max-width:760px){.ss-chip{top:auto;bottom:12px;right:12px;}}
    `;
    const tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
  }
})();
