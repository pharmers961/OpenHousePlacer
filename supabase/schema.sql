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
create policy "own profile - update"
  on public.profiles for update
  using (auth.uid() = id);

drop policy if exists "member can read company" on public.companies;
create policy "member can read company"
  on public.companies for select
  using (
    id in (select company_id from public.profiles where id = auth.uid())
  );
