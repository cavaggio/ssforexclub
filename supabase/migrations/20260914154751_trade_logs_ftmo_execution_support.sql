alter table public.trade_logs
  drop constraint if exists trade_logs_broker_check;

alter table public.trade_logs
  add constraint trade_logs_broker_check
  check (broker = any (array['oanda'::text, 'alpaca'::text, 'ftmo'::text]));

alter table public.trade_logs
  drop constraint if exists trade_logs_environment_check;

alter table public.trade_logs
  add constraint trade_logs_environment_check
  check (environment = any (
    array[
      'practice'::text,
      'live'::text,
      'paper'::text,
      'challenge'::text,
      'verification'::text,
      'funded'::text,
      'evaluation'::text
    ]
  ));
