begin;

alter table public.broker_connections
  drop constraint if exists broker_connections_broker_check;

alter table public.broker_connections
  add constraint broker_connections_broker_check
  check (broker = any (array['oanda'::text,'alpaca'::text,'ninjatrader'::text,'topstep'::text,'ftmo'::text]));

alter table public.broker_connections
  drop constraint if exists broker_connections_environment_check;

alter table public.broker_connections
  add constraint broker_connections_environment_check
  check (environment = any (array['practice'::text,'live'::text,'paper'::text,'sim'::text,'evaluation'::text,'funded'::text,'challenge'::text,'verification'::text]));

commit;
