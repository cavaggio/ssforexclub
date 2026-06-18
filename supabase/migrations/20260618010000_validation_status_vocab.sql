-- ============================================================================
-- 20260618010000_validation_status_vocab.sql
--
-- Normalize broker_connections.validation_status to the canonical vocabulary
-- used by the app + dashboard: 'pending' | 'validated' | 'failed'.
--
-- Production was observed with validation_status = 'pending', while the earlier
-- futures migration declared a CHECK of ('unvalidated','valid','invalid'). The
-- mismatch meant the app's writes (validated/failed) were rejected by the CHECK
-- and silently dropped. This migration reconciles both directions and is safe to
-- run regardless of which prior state the column is in.
-- ============================================================================

-- Add the column if it somehow doesn't exist yet (idempotent with prior migration).
alter table public.broker_connections
    add column if not exists validation_status text,
    add column if not exists last_validated_at timestamptz;

-- Drop any existing default + CHECK so we can remap values freely.
alter table public.broker_connections alter column validation_status drop default;
alter table public.broker_connections drop constraint if exists broker_connections_validation_status_check;

-- Map every legacy / null value onto the canonical vocabulary.
update public.broker_connections
set validation_status = case
    when validation_status in ('valid', 'validated')   then 'validated'
    when validation_status in ('invalid', 'failed')    then 'failed'
    else 'pending'
end;

-- Re-apply default + the canonical CHECK.
alter table public.broker_connections alter column validation_status set default 'pending';
alter table public.broker_connections
    add constraint broker_connections_validation_status_check
    check (validation_status in ('pending', 'validated', 'failed'));
