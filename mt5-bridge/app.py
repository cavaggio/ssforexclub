"""Signal Stack FTMO MetaTrader 5 bridge.

Run this service on the same Windows VPS as the FTMO MT5 terminal. Signal
Stack sends HMAC-signed HTTPS requests; the bridge verifies the request,
checks the requested account/server, and submits orders through MetaTrader5.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import threading
import time
from typing import Any

import MetaTrader5 as mt5
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request

load_dotenv()

APP_VERSION = "1.0.0"
BRIDGE_API_KEY = os.environ.get("BRIDGE_API_KEY", "").strip()
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "").strip()
BRIDGE_INSTANCE_ID = os.environ.get("BRIDGE_INSTANCE_ID", "ftmo-primary").strip()
MT5_LOGIN = os.environ.get("MT5_LOGIN", "").strip()
MT5_PASSWORD = os.environ.get("MT5_PASSWORD", "")
MT5_SERVER = os.environ.get("MT5_SERVER", "").strip()
MT5_TERMINAL_PATH = os.environ.get("MT5_TERMINAL_PATH", "").strip()
ALLOWED_CLOCK_SKEW_SEC = int(os.environ.get("BRIDGE_ALLOWED_CLOCK_SKEW_SEC", "60"))
DEFAULT_DEVIATION = int(os.environ.get("MT5_DEFAULT_DEVIATION", "20"))
DEFAULT_MAGIC = int(os.environ.get("MT5_MAGIC_NUMBER", "56001"))
MIN_RR = float(os.environ.get("MT5_MIN_RR", "1.5"))
REQUIRE_PROTECTIVE_ORDERS = os.environ.get("MT5_REQUIRE_PROTECTIVE_ORDERS", "true").strip().lower() in {"1", "true", "yes", "on"}
SYMBOL_SUFFIX = os.environ.get("MT5_SYMBOL_SUFFIX", "").strip()
try:
    SYMBOL_MAP = json.loads(os.environ.get("MT5_SYMBOL_MAP_JSON", "{}"))
except json.JSONDecodeError as exc:
    raise RuntimeError("MT5_SYMBOL_MAP_JSON must be valid JSON") from exc

app = FastAPI(title="Signal Stack MT5 Bridge", version=APP_VERSION)
_mt5_lock = threading.RLock()
_seen_nonces: dict[str, int] = {}
_nonce_lock = threading.Lock()


def _require_configuration() -> None:
    missing = [
        name
        for name, value in {
            "BRIDGE_API_KEY": BRIDGE_API_KEY,
            "BRIDGE_SECRET": BRIDGE_SECRET,
            "MT5_LOGIN": MT5_LOGIN,
            "MT5_PASSWORD": MT5_PASSWORD,
            "MT5_SERVER": MT5_SERVER,
        }.items()
        if not value
    ]
    if missing:
        raise RuntimeError(f"Missing bridge environment variable(s): {', '.join(missing)}")
    if not MT5_LOGIN.isdigit():
        raise RuntimeError("MT5_LOGIN must contain digits only")
    if len(BRIDGE_SECRET) < 16:
        raise RuntimeError("BRIDGE_SECRET must be at least 16 characters")


def _prune_nonces(now_ms: int) -> None:
    expiry_ms = ALLOWED_CLOCK_SKEW_SEC * 2 * 1000
    stale = [nonce for nonce, seen_at in _seen_nonces.items() if now_ms - seen_at > expiry_ms]
    for nonce in stale:
        _seen_nonces.pop(nonce, None)


async def _authorized_payload(request: Request) -> dict[str, Any]:
    body = await request.body()
    api_key = request.headers.get("x-signal-stack-key", "")
    timestamp = request.headers.get("x-signal-stack-timestamp", "")
    nonce = request.headers.get("x-signal-stack-nonce", "")
    signature = request.headers.get("x-signal-stack-signature", "")

    if not all((api_key, timestamp, nonce, signature)):
        raise HTTPException(status_code=401, detail="Missing bridge authentication headers")
    if not hmac.compare_digest(api_key, BRIDGE_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid bridge API key")

    try:
        timestamp_ms = int(timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="Invalid bridge timestamp") from exc

    now_ms = int(time.time() * 1000)
    if abs(now_ms - timestamp_ms) > ALLOWED_CLOCK_SKEW_SEC * 1000:
        raise HTTPException(status_code=401, detail="Expired bridge request")

    with _nonce_lock:
        _prune_nonces(now_ms)
        if nonce in _seen_nonces:
            raise HTTPException(status_code=409, detail="Replayed bridge request")

    canonical = timestamp.encode() + b"." + nonce.encode() + b"." + body
    expected = hmac.new(BRIDGE_SECRET.encode(), canonical, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(signature, expected):
        raise HTTPException(status_code=401, detail="Invalid bridge signature")
    with _nonce_lock:
        _seen_nonces[nonce] = now_ms

    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Request body must be valid JSON") from exc

    account = payload.get("account") or {}
    requested_login = str(account.get("login") or "").strip()
    requested_server = str(account.get("server") or "").strip()
    requested_terminal = str(account.get("terminalId") or "").strip()

    if requested_login != MT5_LOGIN or requested_server != MT5_SERVER:
        raise HTTPException(status_code=403, detail="Requested MT5 account does not match this bridge")
    if requested_terminal and requested_terminal != BRIDGE_INSTANCE_ID:
        raise HTTPException(status_code=403, detail="Requested MT5 terminal does not match this bridge")

    return payload


def _as_dict(value: Any) -> Any:
    if hasattr(value, "_asdict"):
        return {key: _as_dict(item) for key, item in value._asdict().items()}
    if isinstance(value, (list, tuple)):
        return [_as_dict(item) for item in value]
    if isinstance(value, dict):
        return {key: _as_dict(item) for key, item in value.items()}
    return value


def _last_error() -> str:
    code, message = mt5.last_error()
    return f"{code}: {message}"


def _ensure_mt5() -> Any:
    _require_configuration()
    with _mt5_lock:
        account = mt5.account_info()
        if account and str(account.login) == MT5_LOGIN and str(account.server) == MT5_SERVER:
            return account

        kwargs: dict[str, Any] = {
            "login": int(MT5_LOGIN),
            "password": MT5_PASSWORD,
            "server": MT5_SERVER,
            "timeout": 60_000,
        }
        if MT5_TERMINAL_PATH:
            kwargs["path"] = MT5_TERMINAL_PATH

        if not mt5.initialize(**kwargs):
            raise RuntimeError(f"MetaTrader 5 initialize failed: {_last_error()}")

        account = mt5.account_info()
        if account is None:
            raise RuntimeError(f"MetaTrader 5 account_info failed: {_last_error()}")
        if str(account.login) != MT5_LOGIN or str(account.server) != MT5_SERVER:
            raise RuntimeError("MetaTrader 5 connected to an unexpected account or server")
        return account


def _resolve_symbol(raw_symbol: str) -> tuple[str, Any]:
    mapped = str(SYMBOL_MAP.get(raw_symbol, "")).strip()
    compact = raw_symbol.replace("_", "")
    candidates = [mapped, raw_symbol, compact, f"{compact}{SYMBOL_SUFFIX}" if SYMBOL_SUFFIX else ""]
    for symbol in dict.fromkeys(candidate for candidate in candidates if candidate):
        info = mt5.symbol_info(symbol)
        if info is None:
            continue
        if not info.visible and not mt5.symbol_select(symbol, True):
            continue
        return symbol, mt5.symbol_info(symbol)
    raise HTTPException(status_code=400, detail=f"MT5 symbol not found: {raw_symbol}")


def _filling_mode(info: Any) -> int:
    mode = int(getattr(info, "filling_mode", mt5.ORDER_FILLING_IOC))
    valid = {mt5.ORDER_FILLING_FOK, mt5.ORDER_FILLING_IOC, mt5.ORDER_FILLING_RETURN}
    return mode if mode in valid else mt5.ORDER_FILLING_IOC


def _successful_retcode(retcode: int) -> bool:
    return retcode in {
        mt5.TRADE_RETCODE_DONE,
        mt5.TRADE_RETCODE_DONE_PARTIAL,
        mt5.TRADE_RETCODE_PLACED,
    }


@app.on_event("startup")
def startup() -> None:
    _require_configuration()


@app.post("/v1/health")
async def health(request: Request) -> dict[str, Any]:
    await _authorized_payload(request)
    try:
        with _mt5_lock:
            account = _ensure_mt5()
            terminal = mt5.terminal_info()
        return {
            "ok": True,
            "adapter": "mt5_bridge",
            "version": APP_VERSION,
            "terminalConnected": terminal is not None,
            "tradeAllowed": bool(getattr(account, "trade_allowed", False)),
            "login": str(account.login),
            "server": str(account.server),
            "terminalId": BRIDGE_INSTANCE_ID,
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/account/summary")
async def account_summary(request: Request) -> dict[str, Any]:
    await _authorized_payload(request)
    try:
        with _mt5_lock:
            account = _ensure_mt5()
        data = _as_dict(account)
        return {
            "ok": True,
            "account": {
                "login": str(data.get("login")),
                "server": data.get("server"),
                "currency": data.get("currency"),
                "balance": data.get("balance"),
                "equity": data.get("equity"),
                "margin": data.get("margin"),
                "marginFree": data.get("margin_free"),
                "marginLevel": data.get("margin_level"),
                "profit": data.get("profit"),
                "tradeAllowed": data.get("trade_allowed"),
            },
        }
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/positions/list")
async def positions_list(request: Request) -> dict[str, Any]:
    await _authorized_payload(request)
    try:
        with _mt5_lock:
            _ensure_mt5()
            positions = mt5.positions_get()
        if positions is None:
            raise RuntimeError(f"MetaTrader 5 positions_get failed: {_last_error()}")
        return {"ok": True, "positions": _as_dict(list(positions))}
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/orders/place")
async def orders_place(request: Request) -> dict[str, Any]:
    payload = await _authorized_payload(request)
    order = payload.get("order") or {}
    symbol = str(order.get("symbol") or "").strip()
    side = str(order.get("side") or "").strip().lower()

    try:
        volume = float(order.get("volume"))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Order volume must be numeric") from exc

    if not symbol:
        raise HTTPException(status_code=400, detail="Order symbol is required")
    if side not in {"buy", "sell"}:
        raise HTTPException(status_code=400, detail="Order side must be buy or sell")
    if volume <= 0:
        raise HTTPException(status_code=400, detail="Order volume must be greater than 0")

    try:
        with _mt5_lock:
            _ensure_mt5()
            symbol, info = _resolve_symbol(symbol)
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                raise RuntimeError(f"MetaTrader 5 tick unavailable for {symbol}: {_last_error()}")
            entry_price = float(tick.ask if side == "buy" else tick.bid)

            stop_loss = order.get("stopLoss")
            take_profit = order.get("takeProfit")
            if REQUIRE_PROTECTIVE_ORDERS and (stop_loss is None or take_profit is None):
                raise HTTPException(status_code=400, detail="Stop loss and take profit are required")
            if stop_loss is not None and take_profit is not None:
                sl = float(stop_loss)
                tp = float(take_profit)
                risk = entry_price - sl if side == "buy" else sl - entry_price
                reward = tp - entry_price if side == "buy" else entry_price - tp
                if risk <= 0 or reward <= 0:
                    raise HTTPException(status_code=400, detail="Stop loss and take profit are on the wrong side of market price")
                if reward / risk + 1e-9 < MIN_RR:
                    raise HTTPException(status_code=400, detail=f"Risk/reward must be at least {MIN_RR:g}")

            request_data: dict[str, Any] = {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": symbol,
                "volume": volume,
                "type": mt5.ORDER_TYPE_BUY if side == "buy" else mt5.ORDER_TYPE_SELL,
                "price": entry_price,
                "deviation": int(order.get("deviation") or DEFAULT_DEVIATION),
                "magic": int(order.get("magic") or DEFAULT_MAGIC),
                "comment": str(order.get("comment") or "Signal Stack FTMO")[:31],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": _filling_mode(info),
            }
            if order.get("stopLoss") is not None:
                request_data["sl"] = float(order["stopLoss"])
            if order.get("takeProfit") is not None:
                request_data["tp"] = float(order["takeProfit"])

            check = mt5.order_check(request_data)
            if check is None:
                raise RuntimeError(f"MetaTrader 5 order_check failed: {_last_error()}")
            if int(check.retcode) != 0:
                raise HTTPException(status_code=409, detail={"error": "MT5 order check rejected", "check": _as_dict(check)})

            result = mt5.order_send(request_data)
            if result is None:
                raise RuntimeError(f"MetaTrader 5 order_send failed: {_last_error()}")
            if not _successful_retcode(int(result.retcode)):
                raise HTTPException(status_code=409, detail={"error": "MT5 order rejected", "result": _as_dict(result)})

        return {"ok": True, "result": _as_dict(result)}
    except HTTPException:
        raise
    except (RuntimeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/positions/close")
async def positions_close(request: Request) -> dict[str, Any]:
    payload = await _authorized_payload(request)
    position_input = payload.get("position") or {}
    raw_ticket = position_input.get("positionId") or position_input.get("ticket")

    try:
        ticket = int(str(raw_ticket))
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="positionId must be a numeric MT5 ticket") from exc

    try:
        with _mt5_lock:
            _ensure_mt5()
            matches = mt5.positions_get(ticket=ticket)
            if not matches:
                raise HTTPException(status_code=404, detail=f"MT5 position not found: {ticket}")
            position = matches[0]
            symbol, info = _resolve_symbol(position.symbol)
            tick = mt5.symbol_info_tick(symbol)
            if tick is None:
                raise RuntimeError(f"MetaTrader 5 tick unavailable for {position.symbol}: {_last_error()}")

            close_volume = float(position_input.get("volume") or position.volume)
            if close_volume <= 0 or close_volume > float(position.volume):
                raise HTTPException(status_code=400, detail="Close volume must be greater than 0 and no more than the open volume")

            is_buy = int(position.type) == mt5.POSITION_TYPE_BUY
            request_data = {
                "action": mt5.TRADE_ACTION_DEAL,
                "position": ticket,
                "symbol": symbol,
                "volume": close_volume,
                "type": mt5.ORDER_TYPE_SELL if is_buy else mt5.ORDER_TYPE_BUY,
                "price": tick.bid if is_buy else tick.ask,
                "deviation": int(position_input.get("deviation") or DEFAULT_DEVIATION),
                "magic": int(position_input.get("magic") or DEFAULT_MAGIC),
                "comment": str(position_input.get("comment") or "Signal Stack close")[:31],
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": _filling_mode(info),
            }
            result = mt5.order_send(request_data)
            if result is None:
                raise RuntimeError(f"MetaTrader 5 close order failed: {_last_error()}")
            if not _successful_retcode(int(result.retcode)):
                raise HTTPException(status_code=409, detail={"error": "MT5 close rejected", "result": _as_dict(result)})

        return {"ok": True, "result": _as_dict(result)}
    except HTTPException:
        raise
    except (RuntimeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
