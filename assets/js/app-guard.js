/* ===========================================================================
 * SignDeployer — app gate (runs on app.html only)
 *  - Requires a signed-in user with an ACTIVE subscription.
 *  - Not signed in           → redirect to the landing page (/)
 *  - Signed in, not subscribed → redirect to /#pricing
 *  - Subscribed              → reveal the tool, apply company branding,
 *                              and show the account chip (Billing / Sign out)
 * ========================================================================= */
(function () {
  const cfg = window.SIGNDEPLOYER_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT') &&
    cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_ANON_KEY.includes('YOUR-');

  injectStyles();

  // --- Demo (public "Try the app", ?demo=1) ---------------------------------
  // Skips the paywall and runs the tool in locked demo mode (the app fixes the
  // listing). Driven purely by the URL param, so it persists across refresh and
  // there is no hidden admin/bypass code anywhere in the client.
  if (new URLSearchParams(location.search).get('demo') === '1') { mountDemoChip(); return; }

  const gate = buildGate();
  document.body.appendChild(gate.el);

  // Local/dev (no Supabase configured): leave the app open.
  if (!configured) { gate.el.remove(); return; }
  if (!window.supabase) { gate.msg('Could not load the login library.'); return; }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const ACTIVE = ['active', 'trialing'];

  start();

  async function start() {
    const { data } = await sb.auth.getSession();
    const user = data.session?.user;
    if (!user) return (location.href = '/');

    let access = await loadAccess(user);

    // Just paid? The webhook can lag a few seconds — poll briefly.
    if (!access.active && new URLSearchParams(location.search).get('checkout') === 'success') {
      for (let i = 0; i < 8 && !access.active; i++) {
        gate.msg('Finalizing your subscription…');
        await sleep(1500);
        access = await loadAccess(user);
      }
    }

    if (!access.active) return (location.href = '/#pricing');

    // Granted.
    applyBranding(access.branding);
    mountChip(user, access);
    if (location.search.includes('checkout=')) history.replaceState({}, '', location.pathname);
    gate.el.remove();
  }

  async function loadAccess(user) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
    let branding = null;
    let active = ACTIVE.includes(profile?.subscription_status);
    if (profile?.company_id) {
      const { data: company } = await sb
        .from('companies').select('*').eq('id', profile.company_id).maybeSingle();
      if (company) {
        active = active || ACTIVE.includes(company.subscription_status);
        branding = company;
      }
    }
    return { profile, branding, active };
  }

  function applyBranding(company) {
    if (!company) return;
    const logo = document.getElementById('brandLogo');
    if (company.logo_url && logo) logo.src = company.logo_url;
    if (company.name) {
      const sub = document.querySelector('.brand p');
      if (sub) sub.textContent = company.name;
      if (logo) logo.alt = company.name;
    }
    if (company.brand_color) document.documentElement.style.setProperty('--ink', company.brand_color);
  }

  function mountChip(user, access) {
    const chip = document.createElement('div');
    chip.className = 'sd-chip';
    chip.innerHTML = `
      <span>${escapeHtml(user.email)} · ${access.branding ? 'Brokerage' : 'Agent'}</span>
      <a class="sd-link" href="/account.html">Account</a>
      <button class="sd-link" id="sd-billing">Billing</button>
      <button class="sd-link" id="sd-signout">Sign out</button>`;
    document.body.appendChild(chip);
    document.getElementById('sd-billing').addEventListener('click', manageBilling);
    document.getElementById('sd-signout').addEventListener('click', signOut);
  }

  async function manageBilling() {
    const token = (await sb.auth.getSession()).data.session?.access_token;
    const r = await fetch('/api/create-portal-session', {
      method: 'POST', headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (data.url) location.href = data.url; else alert(data.error || 'Could not open billing.');
  }

  async function signOut() { await sb.auth.signOut(); location.href = '/'; }

  // ---- demo mode chip ----
  function mountDemoChip() {
    const chip = document.createElement('div');
    chip.className = 'sd-chip';
    chip.innerHTML = `<span>🎬 Demo</span><a class="sd-link" href="/">Home</a>`;
    document.body.appendChild(chip);
  }

  // ---- gate overlay + helpers ----
  function buildGate() {
    const el = document.createElement('div');
    el.className = 'sd-gate';
    el.innerHTML = `<div class="sd-spin"></div><p class="sd-gate-msg">Loading…</p>`;
    return { el, msg: (t) => { const p = el.querySelector('.sd-gate-msg'); if (p) p.textContent = t; } };
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function injectStyles() {
    const css = `
    .sd-gate{position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;align-items:center;
      justify-content:center;background:#fff;font-family:'Montserrat',system-ui,sans-serif;gap:6px;}
    .sd-gate-msg{color:#666;font-size:13px;}
    .sd-spin{width:30px;height:30px;border:3px solid #eee;border-top-color:#0a0a0a;border-radius:50%;
      animation:sd-rot .8s linear infinite;}
    @keyframes sd-rot{to{transform:rotate(360deg)}}
    .sd-chip{position:fixed;top:12px;right:12px;z-index:9998;background:rgba(255,255,255,.96);
      border:1px solid #e6e6e6;border-radius:20px;padding:6px 10px;display:flex;align-items:center;gap:6px;
      font-family:'Montserrat',sans-serif;font-size:12px;color:#333;box-shadow:0 4px 14px rgba(0,0,0,.12);}
    .sd-link{background:none;border:none;color:#666;text-decoration:underline;cursor:pointer;font:inherit;
      font-size:12px;padding:4px 6px;}
    @media (max-width:760px){.sd-chip{top:auto;bottom:12px;right:12px;}}`;
    const tag = document.createElement('style'); tag.textContent = css; document.head.appendChild(tag);
  }
})();
