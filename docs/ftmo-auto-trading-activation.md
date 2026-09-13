# FTMO MT5 auto-trading activation

Signal Stack uses the outbound MetaTrader 5 EA bridge for FTMO execution. FTMO must never silently fall back to OANDA order execution.

## Current activation gates

A FTMO prop account can be selected as the active execution account only when:

- the saved broker connection is active;
- the matching `mt5_ea_terminals` row is `connected`;
- the most recent heartbeat is no older than 120 seconds; and
- the user has accepted the trading-risk acknowledgement.

Automatic MT5 order queueing is fail-closed behind all three environment flags:

```text
FTMO_AUTO_TRADE_ENABLED=true
FTMO_LIVE_EXECUTION_ENABLED=true
FTMO_ORDER_TEST_VERIFIED=true
```

`FTMO_ORDER_TEST_VERIFIED` must remain false until a minimum-volume order has been opened and closed successfully through Signal Stack -> MT5 EA -> FTMO and the broker ticket/result has been reconciled back into Signal Stack.

## Production sequence

1. Connect the MT5 EA and confirm recurring heartbeat.
2. Run health, account summary, and positions-list commands.
3. Select the FTMO Challenge / Verification / Funded account as the active execution mode.
4. Keep all three auto-execution flags false during connectivity and sizing verification.
5. Run one controlled minimum-volume order test with the autonomous scheduler disabled.
6. Verify symbol mapping, side, volume, SL, TP, broker ticket, close result, and Signal Stack audit records.
7. Set `FTMO_ORDER_TEST_VERIFIED=true`.
8. Enable `FTMO_LIVE_EXECUTION_ENABLED=true` only after the test passes.
9. Enable `FTMO_AUTO_TRADE_ENABLED=true` last.

## Architecture boundary

- OANDA may remain a market-data / analysis source where needed.
- FTMO-selected accounts must use the dedicated MT5 command queue for order placement and close commands.
- The legacy OANDA auto-execution route must never be used as a fallback for an active FTMO account.
- A stale or missing MT5 heartbeat blocks new FTMO commands.
- Duplicate commands are blocked with an idempotency key.

## Files

- `web/lib/ftmoAutoExecution.ts` — fail-closed FTMO command queue router.
- `web/lib/brokerResolver.ts` — active-account resolver with MT5 heartbeat gating.
- `web/app/api/mt5-ea/[op]/route.ts` — EA heartbeat/poll/report transport.
- `web/app/api/ftmo/readiness/route.ts` — authenticated readiness diagnostics.
- `web/components/trading-mode-toggle.tsx` — OANDA and FTMO account selection UI.
