-- ===========================================================================
-- SignDeployer — manual access repair helpers
--
-- Use these in Supabase → SQL Editor when someone has paid (Stripe shows the
-- charge) but the app still locks them out — usually because the Stripe webhook
-- couldn't link the payment to their account.
--
-- HOW TO USE
--   1. Replace 'person@example.com' with the real email in the block you need.
--   2. Run ONE block at a time (each is independent).
--   3. Re-run the DIAGNOSE block to confirm the result.
--
-- Access rule (for reference): the app lets a user in when EITHER their own
-- profile OR their linked company has subscription_status in ('active',
-- 'trialing'). So either of those is enough to unblock someone.
--
-- These statements are always scoped to a single email, so they can't affect
-- other users. Email matching is case-insensitive.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1) DIAGNOSE — see exactly what state this account is in.
-- ---------------------------------------------------------------------------
select
  p.id            as user_id,
  p.email,
  p.plan,
  p.subscription_status        as profile_status,
  p.company_role,
  p.company_id,
  p.stripe_customer_id,
  c.id            as company_id,
  c.name          as company_name,
  c.subscription_status        as company_status,
  c.owner_id,
  c.stripe_customer_id         as company_customer
from public.profiles p
left join public.companies c on c.id = p.company_id
where lower(p.email) = lower('person@example.com');

-- Look for a company that was created by the webhook but never linked to a user
-- (owner_id is null is the tell-tale sign of a failed link):
select id, name, owner_id, stripe_customer_id, subscription_status, created_at
from public.companies
where owner_id is null
order by created_at desc
limit 10;


-- ---------------------------------------------------------------------------
-- 2) GRANT — individual AGENT access (the $49/yr or $7/mo plan).
--    Use this for a solo agent who paid but is locked out.
-- ---------------------------------------------------------------------------
update public.profiles
set plan = 'agent',
    subscription_status = 'active'
where lower(email) = lower('person@example.com');


-- ---------------------------------------------------------------------------
-- 3) GRANT — BROKERAGE OWNER access.
--    Step 3a unblocks them immediately (activates the profile as an owner).
--    Step 3b links them to the company row Stripe created, if one exists, so
--    branding + the team dashboard work. Safe to run both.
-- ---------------------------------------------------------------------------
-- 3a) Activate the profile as a brokerage owner:
update public.profiles
set plan = 'brokerage',
    company_role = 'owner',
    subscription_status = 'active'
where lower(email) = lower('person@example.com');

-- 3b) Link the matching company (matched via the shared Stripe customer id),
--     mark it active, and set this user as its owner:
with u as (
  select id, stripe_customer_id
  from public.profiles
  where lower(email) = lower('person@example.com')
)
update public.companies c
set owner_id = u.id,
    subscription_status = 'active'
from u
where c.stripe_customer_id = u.stripe_customer_id
  and u.stripe_customer_id is not null;

-- ...then point the profile at that company:
update public.profiles p
set company_id = c.id
from public.companies c
where lower(p.email) = lower('person@example.com')
  and c.stripe_customer_id = p.stripe_customer_id
  and p.stripe_customer_id is not null
  and p.company_id is null;


-- ---------------------------------------------------------------------------
-- 4) ATTACH A MEMBER — add an agent to an existing brokerage by company name.
--    Their access then comes from the company's subscription (no charge).
-- ---------------------------------------------------------------------------
update public.profiles p
set company_id = c.id,
    company_role = 'member'
from public.companies c
where lower(p.email) = lower('member@example.com')
  and c.name = 'EXACT Company Name Here';


-- ---------------------------------------------------------------------------
-- 5) REVOKE — remove access (e.g. a refund or test cleanup).
-- ---------------------------------------------------------------------------
update public.profiles
set subscription_status = 'canceled'
where lower(email) = lower('person@example.com');
-- For a brokerage, also cancel the company so its members lose access:
-- update public.companies
-- set subscription_status = 'canceled'
-- where owner_id = (select id from public.profiles where lower(email) = lower('person@example.com'));
