-- Account-scoped proof that Edge Intelligence playbooks were evaluated for an
-- auto-trade run and, when the ET window matched, received an earlier scan.
-- Priority never bypasses the native engine's confidence, R:R, risk, spread,
-- news, margin, drawdown, duplicate, or broker gates.

create extension if not exists pgcrypto;

create table if not exists public.pair_playbook_priority_audit (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  broker_account_id text not null,
  environment text not null default 'unknown',
  engine text not null check (engine in ('ict', 'ppr', 'v3')),
  run_id text not null,
  scan_mode text not null,
  policy_version text not null,
  ny_time_bucket text not null,
  playbooks_loaded integer not null default 0,
  eligible_playbooks integer not null default 0,
  window_matched_playbooks integer not null default 0,
  selected_pairs jsonb not null default '[]'::jsonb,
  evaluations jsonb not null default '[]'::jsonb,
  prescan_attempted boolean not null default false,
  prescan_ok boolean,
  prescan_status integer,
  prescan_error text,
  safeguards jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, broker_account_id, engine, run_id)
);

create index if not exists pair_playbook_priority_audit_scope_idx
  on public.pair_playbook_priority_audit
  (user_id, broker_account_id, engine, created_at desc);

alter table public.pair_playbook_priority_audit enable row level security;
revoke all on public.pair_playbook_priority_audit from anon, authenticated;

comment on table public.pair_playbook_priority_audit is
  'Per-account auto-trade proof of playbook eligibility, ET-window matching, and bounded priority pre-scan application.';
