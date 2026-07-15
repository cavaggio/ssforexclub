# Signal Stack FTMO MT5 Bridge

This service runs on the same **Windows VPS** as the FTMO MetaTrader 5 terminal. It converts authenticated Signal Stack requests into MT5 account, position, order, and close-position operations.

## Credential split

Signal Stack stores an encrypted connection containing:

- FTMO MT5 login number
- Exact FTMO MT5 server name
- HTTPS bridge URL
- Bridge API key
- Bridge HMAC secret
- Bridge terminal ID

The Windows bridge stores:

- The same bridge API key and HMAC secret
- FTMO MT5 login number
- FTMO MT5 master trading password
- Exact FTMO MT5 server name
- Optional `terminal64.exe` path

The FTMO master password does **not** need to be stored in the Signal Stack database. Do not use the investor/read-only password because it cannot place trades.

## Setup

1. Install FTMO MetaTrader 5 on a Windows VPS and confirm that the FTMO account logs in successfully.
2. Copy `.env.example` to `.env` and fill in the exact login, master password, and server shown in the FTMO Client Area.
3. Generate a long random `BRIDGE_API_KEY` and `BRIDGE_SECRET`. Use the exact same values in the Signal Stack FTMO connection form.
4. Run `start_bridge.ps1` from PowerShell.
5. Put an HTTPS reverse proxy or secure tunnel in front of `127.0.0.1:8787`. The public bridge URL must be reachable from Railway and must use HTTPS.
6. Enter that HTTPS URL in the Signal Stack FTMO dashboard and save the account.
7. Keep `FTMO_LIVE_EXECUTION_ENABLED=false` until the health check, account summary, positions, and paper-sized order tests all pass.

## Bridge endpoints

All endpoints use `POST` and require these headers:

- `x-signal-stack-key`
- `x-signal-stack-timestamp`
- `x-signal-stack-nonce`
- `x-signal-stack-signature`

The signature is lowercase hex HMAC-SHA256 over:

```text
<timestamp>.<nonce>.<raw JSON request body>
```

Endpoints:

- `/v1/health`
- `/v1/account/summary`
- `/v1/positions/list`
- `/v1/orders/place`
- `/v1/positions/close`

The bridge rejects stale timestamps, reused nonces, invalid signatures, and requests for an account/server/terminal other than the one configured on the VPS.

## Symbol and order safety

The bridge accepts Signal Stack symbols such as `EUR_USD` and automatically tries the compact MT5 form (`EURUSD`). Use `MT5_SYMBOL_SUFFIX` or `MT5_SYMBOL_MAP_JSON` when the FTMO terminal uses a broker-specific symbol name. Entry orders require stop loss and take profit by default and independently enforce `MT5_MIN_RR=1.5`.
