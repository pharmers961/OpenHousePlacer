# SignDeployer — Paid Plans Setup Guide

This turns SignDeployer from a free static page into a subscription product:

- **Individual Agent** — $49 / year (or $7 / month), one real-estate agent.
- **Brokerage** — $499 / year, up to 50 agents + your company's branding.

You only need to do the account steps below **once**. Until you finish them,
the site keeps working exactly as it does today (the paywall stays off).

> **Time:** ~45–60 minutes. No prior backend experience required — just follow
> each step in order and copy/paste the keys where indicated.

---

## How it fits together

```
Agent visits site → signs in (email link) → "Have they paid?" check
       └─ paid → full app          └─ not paid → paywall → Stripe Checkout
Stripe → (webhook) → our backend → updates the database → unlocks the agent
```

- **Stripe** collects money & handles renewals.
- **Supabase** stores accounts + who has paid (the database & login).
- **Netlify** hosts the site and the small backend (`/api` functions).

---

## Step 1 — Create a Supabase project (the database + login)

1. Go to <https://supabase.com> → **Start your project** → sign in with GitHub.
2. **New project**. Pick a name (e.g. `signdeployer`), set a database password
   (save it somewhere), choose a region near your users. Wait ~2 min.
3. Left sidebar → **SQL Editor** → **New query**. Open the file
   [`supabase/schema.sql`](supabase/schema.sql) from this repo, copy ALL of it,
   paste it in, and click **Run**. You should see "Success".
4. Left sidebar → **Project Settings** (gear) → **API**. Copy these three values
   into a scratch note — you'll need them shortly:
   - **Project URL** → `https://xxxx.supabase.co`
   - **anon public** key
   - **service_role** key  ⚠️ *secret — never put this in the website code or git*
5. Left sidebar → **Authentication** → **Providers** → make sure **Email** is
   enabled (it is by default). This powers the "email me a sign-in link" login.

---

## Step 2 — Create your Stripe products & prices

1. Go to <https://stripe.com> → create an account. Stay in **Test mode** (toggle
   top-right) while building.
2. Left sidebar → **Product catalog** → **Add product**:
   - **Individual Agent** — add **two** recurring prices on the same product:
     **$49 Yearly** and **$7 Monthly**. Save.
   - **Brokerage** — recurring price **$499**, billing period **Yearly**. Save.
3. Open the products and copy each **Price ID** (looks like `price_1AbC...`,
   NOT the `prod_...` id). You now have `AGENT_PRICE_ID` (the $49/yr),
   `AGENT_MONTHLY_PRICE_ID` (the $7/mo), and `ENTERPRISE_PRICE_ID` (the $499/yr
   Brokerage — env var name is legacy).
4. Left sidebar → **Developers** → **API keys**. Copy the **Secret key**
   (`sk_test_...`).

*(You'll set up the webhook in Step 4, after the site is deployed.)*

---

## Step 3 — Deploy to Netlify

1. Push this branch to GitHub (already done if you're reading this there).
2. Go to <https://app.netlify.com> → sign in with GitHub → **Add new site →
   Import an existing project** → pick GitHub → choose this repository.
3. **Branch to deploy:** select `claude/loving-johnson-iCjEv` (where this work
   lives). Leave **Build command** empty and **Publish directory** as `.`
   (the included `netlify.toml` already sets the functions folder). Click
   **Deploy site**. When it finishes, note the URL (e.g.
   `https://something.netlify.app`).
4. In the Netlify site → **Site configuration → Environment variables** →
   **Add a variable** (use "Add a single variable" for each). Use the names
   exactly:

   | Name | Value |
   |------|-------|
   | `STRIPE_SECRET_KEY` | `sk_test_...` |
   | `AGENT_PRICE_ID` | `price_...` (Individual $49/yr) |
   | `AGENT_MONTHLY_PRICE_ID` | `price_...` (Individual $7/mo) |
   | `ENTERPRISE_PRICE_ID` | `price_...` (Brokerage $499/yr) |
   | `SUPABASE_URL` | your Project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | the **secret** key (`sb_secret_...`) |
   | `MAPBOX_TOKEN` | a Mapbox token for the server (see below) |
   | `APP_URL` | your Netlify URL |
   | `STRIPE_WEBHOOK_SECRET` | *fill in Step 4* |

   **About the two Mapbox tokens:** all the expensive Mapbox APIs (geocoding,
   directions, drive-time matrix, road lookups, route optimization) are called
   ONLY by the `/api/map` backend using `MAPBOX_TOKEN`, which never reaches the
   browser — that's what makes the paywall enforceable. Create a dedicated
   token for it at <https://account.mapbox.com/access-tokens/>. The separate
   PUBLIC `pk.` token baked into `app.html` is used only to draw the base map;
   **URL-restrict it to your domain** in the Mapbox dashboard (Account →
   Tokens → URL restrictions) so nobody can reuse it elsewhere.

   Then trigger a redeploy (**Deploys → Trigger deploy → Deploy site**) so the
   variables take effect.

---

## Step 4 — Connect the Stripe webhook

The webhook is how Stripe tells us "this person paid" so we can unlock them.

1. Stripe → **Developers → Webhooks → Add endpoint**.
2. **Endpoint URL:** `https://YOUR-NETLIFY-URL/api/stripe-webhook`
3. **Events to send** — add these:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Save, then open the endpoint and copy its **Signing secret** (`whsec_...`).
5. Back in Netlify, set `STRIPE_WEBHOOK_SECRET` to that value and **Redeploy**.

---

## Step 5 — Turn the paywall on (public keys)

1. Edit [`assets/js/config.js`](assets/js/config.js) and replace:
   - `SUPABASE_URL` → your Project URL
   - `SUPABASE_ANON_KEY` → the **anon public** key (safe to commit)
   - Optionally update `ENTERPRISE_PRICE_LABEL` to match your real price.
2. Commit & push. Netlify redeploys automatically. The paywall is now live.

> These two values are *public by design* (anon key + price labels). The
> service-role and Stripe secret keys stay in Netlify env vars only.

---

## Step 6 — Test the whole flow (Stripe test mode)

1. Open your site → you should see the **Sign in** screen.
2. Enter your email → click the link in your inbox → you're signed in and see
   the **Choose your plan** paywall.
3. Click **Subscribe** under Agent. On Stripe Checkout use the test card:
   `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
4. After paying you're redirected back and the app **unlocks**. A small account
   chip (Billing / Sign out) appears top-right.
5. Click **Billing** → confirms the Stripe customer portal opens (cancel / update
   card / invoices).
6. Test **Enterprise**: sign in with a different email, enter a company name,
   subscribe. After payment, set that company's `logo_url`, `name`, and
   `brand_color` in Supabase (Table editor → `companies`) and reload — the app
   should show that company's branding.

When everything works, switch Stripe to **Live mode**, recreate the two products
with live prices, swap the Netlify env vars to the **live** keys (`sk_live_...`,
new webhook secret, live price IDs), and redeploy.

---

## How Enterprise "unlimited agents" works (today vs. next)

- **Today:** an Enterprise company is created when someone buys that plan; they
  become its `owner`. To add agents under that company right now, set each
  agent's `company_id` to the company's id in the Supabase `companies`/`profiles`
  tables. They then get access + branding without paying individually.
- **Next phase (optional):** a self-serve "Invite your team" admin screen so the
  owner can add agents by email without touching the database. Say the word and
  I'll build it.

---

## How the paywall is enforced (server-side)

Every Mapbox API call the tool makes goes through the `/api/map` backend, which
requires a signed-in user with an **active subscription** (checked against the
database on every request) and rate-limits each user. The public demo
(`app.html?demo=1`) is allowed through without an account, but it is locked to
the sample listing's area and rate-limited per IP. Reading the page source
doesn't help anyone: without a paid session the backend refuses to do the
geocoding/routing work, so the app is useless without paying.

> **Upgrading an existing project?** Re-run `supabase/schema.sql` in the SQL
> Editor — it's idempotent, and recent versions add the `saved_addresses`
> table (cross-device saved listings) and adjust `rate_limits` so the demo's
> IP-based throttling works.

---

## Quick reference — where each secret goes

| Secret | Lives in | Public? |
|--------|----------|---------|
| Supabase anon key | `assets/js/config.js` | ✅ yes |
| Mapbox public `pk.` token (map tiles only) | `app.html` | ✅ yes — but URL-restrict it |
| Mapbox server token (`MAPBOX_TOKEN`) | Netlify env var | ❌ never |
| Supabase service_role key | Netlify env var | ❌ never |
| Stripe secret key | Netlify env var | ❌ never |
| Stripe webhook secret | Netlify env var | ❌ never |
| Stripe price IDs | Netlify env vars | ❌ keep server-side |
