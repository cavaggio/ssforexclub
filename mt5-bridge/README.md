# Signal Stack FTMO MetaTrader 5 Bridge

This is the connector for **SSForexClub Signal Stack** at
`app.ssforexclub.com/dashboard/ftmo`.

It is **not** an Expert Advisor and no source code is pasted into MetaTrader 5.
The bridge is a Windows service that runs beside the FTMO MT5 desktop terminal
and uses the official `MetaTrader5` Python integration.

```text
Signal Stack scanner / engines
        |
        | HMAC-signed HTTPS requests
        v
Windows VPS: FastAPI MT5 bridge
        |
        | local MetaTrader5 Python integration
        v
FTMO MetaTrader 5 terminal and prop account
```

## What is account-specific

The source code is shared. Each FTMO account gets its own private `.env` file on
the Windows VPS containing:

- exact FTMO MT5 login number;
- exact FTMO MT5 server;
- FTMO **master trading password**;
- terminal executable path;
- unique bridge API key;
- unique HMAC secret;
- unique terminal ID.

The master password stays on the VPS. It is never entered into Signal Stack and
must never be committed to GitHub.

## Required bridge API

The implementation matches the existing Signal Stack clients:

- `POST /v1/diagnostics`
- `POST /v1/health`
- `POST /v1/account/summary`
- `POST /v1/positions/list`
- `POST /v1/symbols/spec`
- `POST /v1/orders/place`
- `POST /v1/positions/close`

Every request must include:

- `x-signal-stack-key`
- `x-signal-stack-timestamp`
- `x-signal-stack-nonce`
- `x-signal-stack-signature`

The signature is lowercase hexadecimal HMAC-SHA256 over the exact raw string:

```text
<timestamp>.<nonce>.<raw JSON body>
```

The bridge fails closed for stale timestamps, reused nonces, wrong API keys,
invalid signatures, or an account/server/terminal mismatch.

## Complete installation

### 1. Prepare a Windows VPS

Use a Windows VPS that can remain online while Signal Stack may trade. Install:

1. FTMO MetaTrader 5 desktop terminal.
2. 64-bit Python 3.11.
3. Git for Windows.
4. An HTTPS reverse proxy or Cloudflare Tunnel connector.

The MetaTrader5 Python package connects to the local desktop terminal, so the
bridge and MT5 terminal must run in the same Windows environment.

### 2. Log into the FTMO account

In the FTMO Client Area, open the account's **Account MetriX > Credentials** and
copy:

- Login;
- master password;
- exact Server;
- FTMO MT5 download link.

Open MT5 and sign in with the same values. Confirm the account number and server
in MT5 and place only a manual demo/free-trial test when appropriate.

### 3. Copy the bridge folder to the VPS

From this repository, copy the entire `mt5-bridge` folder to a private path such
as:

```text
C:\SignalStack\mt5-bridge
```

Do not serve the Git repository itself as a public web directory.

### 4. Create the account-specific `.env`

Open PowerShell in the bridge folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup_bridge.ps1
notepad .env
```

Fill these values exactly:

```dotenv
MT5_LOGIN=<numeric FTMO login>
MT5_PASSWORD=<FTMO master trading password>
MT5_SERVER=<exact FTMO server>
MT5_TERMINAL_PATH=C:\Program Files\FTMO MetaTrader 5\terminal64.exe
BRIDGE_INSTANCE_ID=ftmo-primary
```

`setup_bridge.ps1` generates the API key and HMAC secret locally. Keep them
private.

### 5. Start and locally test the connector

Keep the MT5 terminal open and logged in. In PowerShell:

```powershell
.\start_bridge.ps1
```

In a second PowerShell window:

```powershell
.\test_bridge.ps1
```

A successful response includes:

```json
{
  "ok": true,
  "adapter": "mt5_bridge",
  "terminalConnected": true,
  "accountTradeAllowed": true,
  "login": "<your login>",
  "server": "<your exact server>",
  "terminalId": "ftmo-primary"
}
```

Do not continue until the returned login and server match the intended FTMO
account.

### 6. Publish only the local bridge through HTTPS

The service binds to `127.0.0.1:8787`. Use a stable HTTPS hostname, for example:

```text
https://mt5-ftmo.ssforexclub.com
```

For a Cloudflare Tunnel, publish this origin service:

```text
http://localhost:8787
```

Keep Windows Firewall inbound access to port 8787 closed; the tunnel should make
an outbound connection instead.

### 7. Enter the values in Signal Stack

Open:

```text
https://app.ssforexclub.com/dashboard/ftmo
```

Enter:

| Signal Stack field | Value |
|---|---|
| Environment | Current FTMO stage |
| MT5 Login Number | Same as `MT5_LOGIN` |
| Exact MT5 Server | Same as `MT5_SERVER` |
| HTTPS Bridge URL | Stable public tunnel URL, no `/v1/...` suffix |
| Bridge API Key | Same as `BRIDGE_API_KEY` |
| Bridge HMAC Secret | Same as `BRIDGE_SECRET` |
| Terminal ID | Same as `BRIDGE_INSTANCE_ID` |

The FTMO master password is not entered on the dashboard.

### 8. Keep execution gates off during validation

Keep these application variables disabled until all read-only checks pass:

```dotenv
FTMO_AUTO_TRADE_ENABLED=false
FTMO_LIVE_EXECUTION_ENABLED=false
FTMO_INDICES_AUTO_TRADE_ENABLED=false
FTMO_INDICES_LIVE_EXECUTION_ENABLED=false
```

Validate, in order:

1. bridge diagnostics;
2. exact account identity;
3. account balance/equity;
4. open-position retrieval;
5. symbol specifications;
6. one minimum-size free-trial order with SL and TP;
7. closing that exact test position;
8. position and dashboard reconciliation.

Only then enable the required live gates.

## Symbol handling

Signal Stack forex symbols such as `EUR_USD` are also tried as `EURUSD`.
The FTMO indices engine defaults to `US30.cash`, `US100.cash`, and `US500.cash`.

When MT5 displays different names, set a mapping in `.env`:

```dotenv
MT5_SYMBOL_MAP_JSON={"US30.cash":"US30","US100.cash":"USTEC","US500.cash":"US500"}
```

Use the exact symbols shown in the FTMO MT5 Market Watch window.

## Safety controls

The bridge:

- verifies account login, server, and terminal ID on every request;
- requires HMAC-authenticated requests;
- blocks replayed and expired requests;
- requires stop loss and take profit by default;
- independently enforces `MT5_MIN_RR`;
- reports MT5 order-check and order-send rejection details;
- never stores the FTMO master password in the Signal Stack database.

## Troubleshooting

**`MetaTrader 5 initialize failed`**

Confirm MT5 is installed, logged in, and `MT5_TERMINAL_PATH` points to the exact
`terminal64.exe`.

**Account mismatch**

The dashboard, `.env`, and active MT5 terminal must use the same numeric login
and exact server string.

**Algorithmic trading disabled**

Enable algorithmic trading in the MT5 desktop terminal and confirm the account
permits trading.

**Symbol not found**

Copy the exact Market Watch symbol into `MT5_SYMBOL_MAP_JSON`.

**Bridge URL timeout**

Confirm the bridge is running locally, the tunnel is healthy, and the public
hostname routes to `http://localhost:8787`.
