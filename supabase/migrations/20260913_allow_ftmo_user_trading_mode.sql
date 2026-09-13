alter table public.user_trading_settings
  drop constraint if exists user_trading_settings_active_broker_check;

alter table public.user_trading_settings
  add constraint user_trading_settings_active_broker_check
  check (active_broker = any (array['oanda'::text, 'alpaca'::text, 'ninjatrader'::text, 'topstep'::text, 'ftmo'::text]));

alter table public.user_trading_settings
  drop constraint if exists user_trading_settings_active_environment_check;

alter table public.user_trading_settings
  add constraint user_trading_settings_active_environment_check
  check (active_environment = any (array['practice'::text, 'paper'::text, 'live'::text, 'sim'::text, 'evaluation'::text, 'funded'::text, 'challenge'::text, 'verification'::text]));
