# FTMO Indices Engine Deployment

## Railway server variables

Start in shadow mode:

```env
FTMO_INDICES_ENGINE_MODE=shadow
FTMO_INDICES_AUTO_TRADE_ENABLED=false
FTMO_INDICES_LIVE_EXECUTION_ENABLED=false
FTMO_INDICES_SYMBOLS=US30.cash,US100.cash,US500.cash
FTMO_INDICES_PRIMARY_SYMBOL=US500.cash
FTMO_INDICES_MIN_CONFIDENCE=88
FTMO_INDICES_MIN_RR=1.5
FTMO_INDICES_RISK_PERCENT=0.50
FTMO_INDICES_A_PLUS_RISK_PERCENT=0.75
FTMO_INDICES_GROUP_RISK_PERCENT=0.75
FTMO_INDICES_DAILY_STOP_PERCENT=1.50
FTMO_INDICES_HARD_DAILY_STOP_PERCENT=2.00
FTMO_INDICES_MAX_TRADES_PER_DAY=3
FTMO_INDICES_MAX_CONSECUTIVE_LOSSES=2
FTMO_INDICES_OPENING_RANGE_MINUTES=15
FTMO_INDICES_SIGNAL_TTL_SEC=300
FTMO_INDICES_REQUIRE_SWEEP=true
FTMO_INDICES_REQUIRE_DISPLACEMENT=true
FTMO_INDICES_REQUIRE_STRUCTURE_SHIFT=true
FTMO_INDICES_REQUIRE_PD_ARRAY=true
FTMO_INDICES_ALLOW_MARKET_FALLBACK=false
FTMO_ACCOUNT_MODEL=two_step
```

The existing FTMO bridge variables must remain configured on Railway:

```env
FTMO_ENABLED=true
FTMO_PROVIDER=mt5_bridge
FTMO_MT5_LOGIN=...
FTMO_MT5_SERVER=...
FTMO_MT5_BRIDGE_URL=...
FTMO_MT5_BRIDGE_API_KEY=...
FTMO_MT5_BRIDGE_SECRET=...
FTMO_MT5_TERMINAL_ID=ftmo-primary
```

Do not enable live execution until the MT5 bridge supports `/v1/symbols/spec` and returns tick size, tick value, minimum volume, maximum volume, and volume step for every configured symbol.

## Vercel variables

The analysis and execution engine runs on Railway. Vercel only needs a public display flag if the dashboard is updated to expose the engine:

```env
NEXT_PUBLIC_FTMO_INDICES_ENGINE_ENABLED=true
NEXT_PUBLIC_FTMO_INDICES_PRIMARY_SYMBOL=US500.cash
```

No FTMO bridge secret belongs in Vercel or any `NEXT_PUBLIC_*` variable.

## Supabase

Run `supabase/migrations/20260730_ftmo_indices_engine.sql` in the Supabase SQL Editor when migrations are not automatically applied. The tables are service-role-only and direct anon/authenticated access is denied.

## Activation sequence

1. Deploy with shadow mode and both execution flags false.
2. Verify `GET /api/indices/status`.
3. Verify bridge symbol specifications for all three symbols.
4. Collect and review at least 50 shadow setups.
5. Move to paper mode before enabling active/live execution.
