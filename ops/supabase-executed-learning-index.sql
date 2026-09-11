-- Online maintenance: run this statement outside a transaction.
-- Executed-learning views always filter signal_observations.status='executed'.
-- The full scope index otherwise reads thousands of rejected/pending signals
-- for each request. This small partial index preserves the existing view data,
-- calculations, grants, and RLS while supporting their scoped joins by id.
-- CONCURRENTLY avoids holding a write-blocking table lock during the build.
create index concurrently if not exists signal_observations_executed_learning_idx
  on public.signal_observations (user_id, broker_account_id, engine, pair, id)
  where status = 'executed';

-- Verify readiness/validity after execution:
-- select indisready, indisvalid
-- from pg_index
-- where indexrelid = 'public.signal_observations_executed_learning_idx'::regclass;
--
-- Optional rollback, also outside a transaction:
-- drop index concurrently if exists public.signal_observations_executed_learning_idx;
