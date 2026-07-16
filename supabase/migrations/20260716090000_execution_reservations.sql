create table if not exists public.execution_reservations (
  fingerprint_hash text primary key,
  fingerprint text not null,
  account_id text not null,
  pair text not null,
  direction text not null,
  status text not null check (status in ('reserved','open','released','cancelled','failed','loss_locked','closed')),
  trade_id text,
  expires_at timestamptz not null,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists execution_reservations_trade_id_idx on public.execution_reservations(trade_id) where trade_id is not null;
alter table public.execution_reservations enable row level security;
