-- Allow exactly one of the three autonomous engines to be stored per user.
-- This migration removes any earlier CHECK constraint that only allowed ICT/V3,
-- regardless of the constraint's generated name, then installs the canonical one.

do $$
declare
  constraint_row record;
begin
  for constraint_row in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'user_trading_settings'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%auto_ai_engine%'
  loop
    execute format(
      'alter table public.user_trading_settings drop constraint %I',
      constraint_row.conname
    );
  end loop;

  update public.user_trading_settings
  set auto_ai_engine = 'ict'
  where auto_ai_engine is null
     or auto_ai_engine not in ('ict', 'v3', 'ppr');

  alter table public.user_trading_settings
    alter column auto_ai_engine set default 'ict';

  alter table public.user_trading_settings
    add constraint user_trading_settings_auto_ai_engine_check
    check (auto_ai_engine in ('ict', 'v3', 'ppr'));
end
$$;

comment on column public.user_trading_settings.auto_ai_engine is
  'Mutually exclusive Auto AI engine selection: ict, v3, or ppr.';
