create table if not exists public.daily_market_studies (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  environment text not null default 'unknown',
  engine text not null check (engine in ('ict', 'ppr')),
  pair text not null,
  study_date date not null,
  studied_at timestamptz not null default now(),
  day_open numeric,
  day_high numeric,
  day_low numeric,
  day_close numeric,
  day_direction text,
  prior_day_high numeric,
  prior_day_low numeric,
  institutional_flow jsonb not null default '{}'::jsonb,
  untested_daily_zones jsonb not null default '[]'::jsonb,
  untested_h4_zones jsonb not null default '[]'::jsonb,
  engine_analysis jsonb not null default '{}'::jsonb,
  feature_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, engine, pair, study_date)
);

create index if not exists daily_market_studies_latest_idx
  on public.daily_market_studies (account_id, engine, pair, study_date desc);

alter table public.daily_market_studies enable row level security;

-- Railway writes through the service-role key. Browser clients should not read or
-- mutate raw strategy-learning records directly.
revoke all on table public.daily_market_studies from anon, authenticated;

grant all on table public.daily_market_studies to service_role;

create or replace function public.set_daily_market_studies_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists daily_market_studies_updated_at on public.daily_market_studies;
create trigger daily_market_studies_updated_at
before update on public.daily_market_studies
for each row execute function public.set_daily_market_studies_updated_at();
