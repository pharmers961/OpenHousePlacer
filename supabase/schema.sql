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
  -- Enterprise branding (replaces the default SignDeployer/Luxe look):
  logo_url            text,
  brand_color         text default '#0a0a0a',
  -- Billing:
  owner_id            uuid references auth.users(id),
  stripe_customer_id  text,
  subscription_status text,            -- 'active' | 'trialing' | 'past_due' | 'canceled' | null
  current_period_end  timestamptz,
  created_at          timestamptz not null default now()
);

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

drop policy if exists "branding public read" on storage.objects;
create policy "branding public read"
  on storage.objects for select
  using (bucket_id = 'branding');

-- Uploads/updates are scoped to the uploader's OWN company folder
-- (logos are stored at "<company_id>/..."), so a user can't overwrite or
-- replace another brokerage's logo.
drop policy if exists "branding authenticated upload" on storage.objects;
create policy "branding authenticated upload"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = (
      select company_id::text from public.profiles where id = auth.uid()
    )
  );

drop policy if exists "branding authenticated update" on storage.objects;
create policy "branding authenticated update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'branding'
    and (storage.foldername(name))[1] = (
      select company_id::text from public.profiles where id = auth.uid()
    )
  );
