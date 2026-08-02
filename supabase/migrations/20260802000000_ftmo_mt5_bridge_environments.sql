-- ============================================================================
-- 20260802000000_ftmo_mt5_bridge_environments.sql
--
-- Makes the SSForexClub FTMO MT5 bridge persistable for every dashboard stage,
-- including the FTMO Free Trial used for safe connector testing.
-- ============================================================================

alter table public.broker_connections
    drop constraint if exists broker_connections_broker_check;
alter table public.broker_connections
    add constraint broker_connections_broker_check
    check (broker in ('oanda', 'alpaca', 'ninjatrader', 'topstep', 'ftmo'));

alter table public.broker_connections
    drop constraint if exists broker_connections_environment_check;
alter table public.broker_connections
    add constraint broker_connections_environment_check
    check (
      environment in (
        'practice',
        'live',
        'paper',
        'sim',
        'evaluation',
        'funded',
        'free_trial',
        'challenge',
        'verification'
      )
    );

alter table public.user_trading_settings
    drop constraint if exists user_trading_settings_active_broker_check;
alter table public.user_trading_settings
    add constraint user_trading_settings_active_broker_check
    check (active_broker in ('oanda', 'alpaca', 'ninjatrader', 'topstep', 'ftmo'));

alter table public.user_trading_settings
    drop constraint if exists user_trading_settings_active_environment_check;
alter table public.user_trading_settings
    add constraint user_trading_settings_active_environment_check
    check (
      active_environment in (
        'practice',
        'paper',
        'live',
        'sim',
        'evaluation',
        'funded',
        'free_trial',
        'challenge',
        'verification'
      )
    );
