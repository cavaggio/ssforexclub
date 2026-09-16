-- ICT A-grade precision audit trail.
-- Records only account-scoped qualification / pre-execution / execution decisions.
-- The table is server-only: service-role writers/readers use it for Railway and
-- authenticated Vercel server components; anon/authenticated Data API access is revoked.

create table if not exists public.ict_a_grade_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker text not null,
  broker_account_id text not null,
  environment text,
  pair text not null,
  direction text,
  signal_id text not null,
  decision_stage text not null,
  observed_at timestamptz not null default now(),
  grade text not null,
  score numeric not null,
  threshold numeric not null default 80,
  passed boolean not null default false,
  exhaustion_risk_score numeric,
  components jsonb not null default '{}'::jsonb,
  blockers jsonb not null default '[]'::jsonb,
  analysis_snapshot jsonb not null default '{}'::jsonb,
  execution_telemetry jsonb,
  executed boolean not null default false,
  broker_trade_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ict_a_grade_decisions_grade_check check (grade in ('A','B','C')),
  constraint ict_a_grade_decisions_stage_check check (decision_stage in ('scanner','pre_execution','final_price','executed')),
  constraint ict_a_grade_decisions_score_check check (score >= 0 and score <= 100),
  constraint ict_a_grade_decisions_threshold_check check (threshold >= 0 and threshold <= 100),
  constraint ict_a_grade_decisions_exhaustion_check check (exhaustion_risk_score is null or (exhaustion_risk_score >= 0 and exhaustion_risk_score <= 100)),
  constraint ict_a_grade_decisions_unique_stage unique (user_id, broker_account_id, signal_id, decision_stage)
);

create index if not exists ict_a_grade_decisions_user_observed_idx
  on public.ict_a_grade_decisions (user_id, observed_at desc);
create index if not exists ict_a_grade_decisions_account_observed_idx
  on public.ict_a_grade_decisions (user_id, broker_account_id, observed_at desc);
create index if not exists ict_a_grade_decisions_passed_idx
  on public.ict_a_grade_decisions (user_id, passed, executed, observed_at desc);
create index if not exists ict_a_grade_decisions_pair_idx
  on public.ict_a_grade_decisions (user_id, pair, observed_at desc);

alter table public.ict_a_grade_decisions enable row level security;
revoke all on table public.ict_a_grade_decisions from anon, authenticated;

comment on table public.ict_a_grade_decisions is
  'Account-scoped ICT A-grade qualification and execution audit. Server-only; used to measure prospective setup precision without weakening hard ICT gates.';
comment on column public.ict_a_grade_decisions.score is
  'Deterministic A-grade quality score (0-100), not a predicted win probability.';
comment on column public.ict_a_grade_decisions.exhaustion_risk_score is
  'Deterministic late/exhaustion risk score (0-100); lower is better.';
