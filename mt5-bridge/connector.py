"""Compatibility entry point for the SSForexClub FTMO MT5 bridge.

The original bridge implementation lives in app.py. This module adds the
endpoints required by every current Signal Stack client and is the Uvicorn
entry point used by start_bridge.ps1.
"""

from __future__ import annotations

from typing import Any

import MetaTrader5 as mt5
from fastapi import HTTPException, Request

from app import (
    APP_VERSION,
    BRIDGE_INSTANCE_ID,
    MIN_RR,
    REQUIRE_PROTECTIVE_ORDERS,
    _as_dict,
    _authorized_payload,
    _ensure_mt5,
    _last_error,
    _mt5_lock,
    _resolve_symbol,
    app,
)


def _diagnostics_payload(account: Any) -> dict[str, Any]:
    terminal = mt5.terminal_info()
    return {
        "ok": True,
        "adapter": "mt5_bridge",
        "version": APP_VERSION,
        "terminalConnected": terminal is not None,
        "terminalTradeAllowed": bool(
            getattr(terminal, "trade_allowed", False) if terminal else False
        ),
        "accountTradeAllowed": bool(getattr(account, "trade_allowed", False)),
        "tradeAllowed": bool(getattr(account, "trade_allowed", False)),
        "login": str(account.login),
        "server": str(account.server),
        "terminalId": BRIDGE_INSTANCE_ID,
        "mt5Version": _as_dict(mt5.version()),
        "protectiveOrdersRequired": REQUIRE_PROTECTIVE_ORDERS,
        "minimumRiskReward": MIN_RR,
    }


@app.post("/v1/diagnostics")
async def diagnostics(request: Request) -> dict[str, Any]:
    """Connection test used by the Express FTMO connection store."""
    await _authorized_payload(request)
    try:
        with _mt5_lock:
            account = _ensure_mt5()
            return _diagnostics_payload(account)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/symbols/spec")
async def symbol_spec(request: Request) -> dict[str, Any]:
    """Return the MT5 contract values required for risk-based position sizing."""
    payload = await _authorized_payload(request)
    raw_symbol = str(payload.get("symbol") or "").strip()
    if not raw_symbol:
        raise HTTPException(status_code=400, detail="Symbol is required")

    try:
        with _mt5_lock:
            _ensure_mt5()
            symbol, info = _resolve_symbol(raw_symbol)
        data = _as_dict(info)
        return {
            "ok": True,
            "spec": {
                "requestedSymbol": raw_symbol,
                "symbol": symbol,
                "digits": data.get("digits"),
                "point": data.get("point"),
                "tickSize": data.get("trade_tick_size") or data.get("point"),
                "tickValue": data.get("trade_tick_value"),
                "tickValueProfit": data.get("trade_tick_value_profit"),
                "tickValueLoss": data.get("trade_tick_value_loss"),
                "contractSize": data.get("trade_contract_size"),
                "volumeMin": data.get("volume_min"),
                "volumeMax": data.get("volume_max"),
                "volumeStep": data.get("volume_step"),
                "stopsLevel": data.get("trade_stops_level"),
                "freezeLevel": data.get("trade_freeze_level"),
                "fillingMode": data.get("filling_mode"),
            },
        }
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"MetaTrader 5 symbol specification failed: {exc or _last_error()}",
        ) from exc
