-- ===========================================================================
-- SignDeployer database schema
-- Run this once in Supabase: Dashboard → SQL Editor → paste → Run.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- companies: one row per Enterprise customer (unlimited agents + branding)
-- ---------------------------------------------------------------------------
create table if not exists public.companies (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  -- Brokerage contact details collected at signup (so you know who bought):
  contact_name        text,
  contact_email       text,
  contact_phone       text,
  team_size           text,
  -- Enterprise branding (replaces the default SignDeployer/Luxe look):
  logo_url            text,
  brand_color         text default '#102a43',
  -- Billing:
  owner_id            uuid references auth.users(id),
  stripe_customer_id  text,
  subscription_status text,            -- 'active' | 'trialing' | 'past_due' | 'canceled' | null
  current_period_end  timestamptz,
  created_at          timestamptz not null default now()
);

-- Safe to re-run: add the signup contact columns to an existing companies table.
alter table public.companies add column if not exists contact_name  text;
alter table public.companies add column if not exists contact_email text;
alter table public.companies add column if not exists contact_phone text;
alter table public.companies add column if not exists team_size     text;

-- ---------------------------------------------------------------------------
-- profiles: one row per signed-up user (a real-estate agent)
-- A profile is created automatically when someone signs up (see trigger below).
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text,
  full_name           text,
  -- Individual ("Agent") billing:
  stripe_customer_id  text,
  plan                text,            -- 'agent' | 'enterprise' | null
  subscription_status text,            -- 'active' | 'trialing' | 'past_due' | 'canceled' | null
  current_period_end  timestamptz,
  -- Enterprise membership: if set, this agent's access comes from the company.
  company_id          uuid references public.companies(id),
  company_role        text default 'member',   -- 'owner' | 'member'
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Auto-create a profile row whenever a new auth user signs up.
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Row Level Security
--   - A user can read/update only their OWN profile.
--   - A user can read the company they belong to.
--   - The webhook uses the service-role key, which BYPASSES RLS (so it can
--     update anyone's subscription status after a payment).
-- ---------------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.companies enable row level security;

drop policy if exists "own profile - read"   on public.profiles;
drop policy if exists "own profile - update" on public.profiles;
create policy "own profile - read"
  on public.profiles for select
  using (auth.uid() = id);
-- SECURITY: there is intentionally NO client UPDATE policy on profiles.
-- subscription_status, plan, company_id and company_role are written ONLY by the
-- server (Stripe webhook and /api/team) using the service-role key, which
-- bypasses RLS. If clients could update their own row they could self-grant
-- subscription_status='active' (free access) or company_role='owner'
-- (take over a brokerage). Keep profile edits server-side.

drop policy if exists "member can read company" on public.companies;
create policy "member can read company"
  on public.companies for select
  using (
    id in (select company_id from public.profiles where id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- company_invites: pending seat invitations for the Brokerage plan.
-- An owner invites an email; when that person signs up, the trigger below
-- attaches them to the company automatically. Members already signed up are
-- attached immediately by the /api/team function.
-- ---------------------------------------------------------------------------
create table if not exists public.company_invites (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  email       text not null,
  invited_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  unique (company_id, email)
);

alter table public.company_invites enable row level security;

-- Owners can read invites for their own company (the server uses the
-- service-role key for writes, which bypasses RLS).
drop policy if exists "owner reads own invites" on public.company_invites;
create policy "owner reads own invites"
  on public.company_invites for select
  using (
    company_id in (
      select company_id from public.profiles
      where id = auth.uid() and company_role = 'owner'
    )
  );

-- Recreate handle_new_user so that, in addition to creating the profile, a new
-- user whose email was invited is auto-attached to that company and the invite
-- is consumed.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  inv record;
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;

  select * into inv from public.company_invites
    where lower(email) = lower(new.email)
    order by created_at asc limit 1;

  if inv.company_id is not null then
    update public.profiles
      set company_id = inv.company_id, company_role = 'member'
      where id = new.id;
    delete from public.company_invites where id = inv.id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage: public "branding" bucket for brokerage logos.
-- Owners upload a logo from the account page; the public URL is saved on the
-- company. Public read so the app can display it; authenticated users may
-- upload/replace files in this bucket.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('branding', 'branding', true)
on conflict (id) do nothing;

-- Restrict the bucket to small image files (defense-in-depth; the client also
-- checks). file_size_limit is in bytes (2 MB). SVG is excluded on purpose:
-- SVGs can carry scripts and the bucket is public (stored-XSS risk).
update storage.buckets
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/png','image/jpeg','image/webp']
  where id = 'branding';

-- No public "list/select" policy on purpose: the bucket is public, so each
-- logo's direct URL still loads in the app, but the bucket cannot be LISTED
-- (which would let anyone enumerate company IDs from the folder names).
drop policy if exists "branding public read" on storage.objects;

-- Uploads/updates are scoped to the uploader's OWN company folder
-- (logos are stored at "<company_id>/...") AND to company OWNERS only, so a
-- regular member can't replace their brokerage's logo, and nobody can touch
-- another brokerage's folder. (The /api/upload-logo function enforces the same
-- rule server-side; this covers direct Storage API calls with the anon key.)
drop policy if exists "branding authenticated upload" on storage.objects;
create policy "branding authenticated upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = (
      select company_id::text from public.profiles
      where id = auth.uid() and company_role = 'owner'
    )
  );

drop policy if exists "branding authenticated update" on storage.objects;
create policy "branding authenticated update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = (
      select company_id::text from public.profiles
      where id = auth.uid() and company_role = 'owner'
    )
  );

-- ---------------------------------------------------------------------------
-- rate_limits: per-user, per-endpoint throttling for the serverless functions.
--
-- The Netlify Functions are stateless (no shared memory between invocations),
-- so an in-process counter would reset on every cold start. We keep one row per
-- (user, bucket) here and reset it once the fixed window elapses. Writes happen
-- ONLY via check_rate_limit() below using the service-role key, so RLS stays on
-- with no policies (clients can neither read nor forge their own counters).
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limits (
  user_id      uuid not null,               -- auth user id, OR an IP-derived id for the public demo
  bucket       text not null,               -- endpoint key, e.g. 'invite', 'reconcile', 'map-demo'
  window_start timestamptz not null default now(),
  count        integer not null default 0,
  primary key (user_id, bucket)
);

-- The /api/map demo limiter keys rows by an IP-derived uuid that has no
-- auth.users row, so the table must NOT have a foreign key to auth.users.
-- (Safe to re-run: drops the FK left over from earlier versions of this schema.)
alter table public.rate_limits drop constraint if exists rate_limits_user_id_fkey;

alter table public.rate_limits enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) touches it.

-- Atomic check-and-increment for a fixed window. Returns TRUE if the request is
-- allowed (i.e. the count after incrementing is within p_max), FALSE if the
-- caller has exceeded the limit. The whole read-modify-write happens in one
-- statement, and the ON CONFLICT path locks the row, so concurrent invocations
-- can't race past the cap. When the current window has expired, it rolls over to
-- a fresh window starting now with a count of 1.
create or replace function public.check_rate_limit(
  p_user_id        uuid,
  p_bucket         text,
  p_max            integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer set search_path = public
as $$
declare
  v_now   timestamptz := now();
  v_count integer;
begin
  insert into public.rate_limits as rl (user_id, bucket, window_start, count)
    values (p_user_id, p_bucket, v_now, 1)
  on conflict (user_id, bucket) do update
    set window_start = case
          when rl.window_start < v_now - make_interval(secs => p_window_seconds)
            then v_now
          else rl.window_start
        end,
        count = case
          when rl.window_start < v_now - make_interval(secs => p_window_seconds)
            then 1
          else rl.count + 1
        end
  returning rl.count into v_count;

  return v_count <= p_max;
end;
$$;

-- ---------------------------------------------------------------------------
-- saved_addresses: each agent's saved open-house listings, synced across
-- devices. Previously these lived only in the browser's localStorage, which
-- silently lost a paying agent's data when they switched devices or cleared
-- the browser. RLS: each user can only ever see and modify their own rows.
-- ---------------------------------------------------------------------------
create table if not exists public.saved_addresses (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  address    text not null,
  center     jsonb,                          -- [lng, lat] of the geocoded listing, if known
  created_at timestamptz not null default now(),
  unique (user_id, address)
);

alter table public.saved_addresses enable row level security;

drop policy if exists "own saved addresses - read" on public.saved_addresses;
create policy "own saved addresses - read"
  on public.saved_addresses for select
  using (auth.uid() = user_id);

drop policy if exists "own saved addresses - insert" on public.saved_addresses;
create policy "own saved addresses - insert"
  on public.saved_addresses for insert
  with check (auth.uid() = user_id);

-- Needed for upsert (insert … on conflict do update) when re-saving an address.
drop policy if exists "own saved addresses - update" on public.saved_addresses;
create policy "own saved addresses - update"
  on public.saved_addresses for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "own saved addresses - delete" on public.saved_addresses;
create policy "own saved addresses - delete"
  on public.saved_addresses for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- demo_cache: cached Mapbox responses for the public demo.
-- The demo listing is fixed, so its requests are deterministic — after the
-- first visitor warms a (signs, drive-time) combination, demo searches cost
-- zero Mapbox API calls. Written only by the /api/map function (service role);
-- RLS on with no policies so clients can't read or poison it.
-- ---------------------------------------------------------------------------
create table if not exists public.demo_cache (
  key        text primary key,              -- sha256 of the request kind + params
  response   jsonb not null,                -- the raw Mapbox response served back
  created_at timestamptz not null default now()
);

alter table public.demo_cache enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) touches it.
