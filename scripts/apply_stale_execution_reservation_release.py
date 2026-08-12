#!/usr/bin/env python3
"""Release execution reservations when broker positions are no longer open.

The reservation layer is intentionally separate from the in-memory pair lock. A
broker-side TP/SL/manual close could clear the pair lock while leaving the setup
reservation marked `open` for the remainder of its TTL. This patch makes broker
truth authoritative and releases stale open reservations on reconciliation and
all terminal execution paths without touching a concurrent in-flight reservation.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TRADE = ROOT / "server" / "oandaTrade.js"
ICT = ROOT / "server" / "ictExecution.js"


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"stale reservation patch marker missing: {label}")
    return text.replace(old, new, 1)


trade = TRADE.read_text(encoding="utf-8")
trade = replace_once(
    trade,
    "import { reserveExecution, markExecutionOpen, releaseExecution } from './executionReservations.js';",
    "import {\n"
    "  reserveExecution,\n"
    "  markExecutionOpen,\n"
    "  releaseExecution,\n"
    "  releaseExecutionByTradeId,\n"
    "  releaseExecutionsForPairDirection,\n"
    "} from './executionReservations.js';",
    "reservation lifecycle imports",
)

trade = replace_once(
    trade,
    "  if (hadLocalLock) {\n"
    "    console.warn(`[STALE LOCK REMOVED] ${key} — broker has no matching open position; releasing in-memory lock`);\n"
    "    activeTrades.delete(key);\n"
    "  } else {\n"
    "    console.log(`[BROKER POSITION CLEAR] ${key} — no broker position exists`);\n"
    "  }\n\n"
    "  return false;",
    "  if (hadLocalLock) {\n"
    "    console.warn(`[STALE LOCK REMOVED] ${key} — broker has no matching open position; releasing in-memory lock`);\n"
    "    activeTrades.delete(key);\n"
    "  } else {\n"
    "    console.log(`[BROKER POSITION CLEAR] ${key} — no broker position exists`);\n"
    "  }\n\n"
    "  // Broker truth releases only an old `open` reservation. A `reserved` row\n"
    "  // may belong to another execution request that is currently between its\n"
    "  // atomic reservation and broker fill, so reconciliation must not erase it.\n"
    "  // Loss locks are also excluded and remain enforceable.\n"
    "  try {\n"
    "    const cleanup = await releaseExecutionsForPairDirection({\n"
    "      accountId: client?.accountId,\n"
    "      pair,\n"
    "      direction,\n"
    "      status: 'released',\n"
    "      statuses: ['open'],\n"
    "    });\n"
    "    if (cleanup.released > 0) {\n"
    "      console.warn(`[STALE RESERVATION RELEASED] ${key} — released ${cleanup.released} local reservation(s)`);\n"
    "    }\n"
    "  } catch (err) {\n"
    "    console.warn(`[STALE RESERVATION CLEANUP] ${key} — ${err?.message || err}`);\n"
    "  }\n\n"
    "  return false;",
    "broker-clear reservation cleanup",
)

trade = replace_once(
    trade,
    "    activeTrades.delete(`${instrument}_long`);\n"
    "    activeTrades.delete(`${instrument}_short`);\n"
    "    console.log(`[TRADE] ✓ Position closed: ${instrument}`);",
    "    activeTrades.delete(`${instrument}_long`);\n"
    "    activeTrades.delete(`${instrument}_short`);\n"
    "    await Promise.all([\n"
    "      releaseExecutionsForPairDirection({ accountId, pair: instrument, direction: 'long', statuses: ['open'] }),\n"
    "      releaseExecutionsForPairDirection({ accountId, pair: instrument, direction: 'short', statuses: ['open'] }),\n"
    "    ]);\n"
    "    console.log(`[TRADE] ✓ Position closed: ${instrument}`);",
    "legacy position close reservation cleanup",
)

trade = replace_once(
    trade,
    "    if (instrument) {\n"
    "      // Best-effort cleanup of the local lock cache for full closes.\n"
    "      if (isFullClose) {\n"
    "        activeTrades.delete(`${instrument}_long`);\n"
    "        activeTrades.delete(`${instrument}_short`);\n"
    "      }\n"
    "    }\n"
    "    console.log(",
    "    if (instrument) {\n"
    "      // Best-effort cleanup of the local lock cache for full closes.\n"
    "      if (isFullClose) {\n"
    "        activeTrades.delete(`${instrument}_long`);\n"
    "        activeTrades.delete(`${instrument}_short`);\n"
    "      }\n"
    "    }\n"
    "    if (isFullClose) {\n"
    "      try {\n"
    "        await releaseExecutionByTradeId(tradeId, 'released');\n"
    "      } catch (releaseError) {\n"
    "        console.warn(`[TRADE_CLOSE] reservation release failed tradeId=${tradeId}: ${releaseError?.message || releaseError}`);\n"
    "      }\n"
    "    }\n"
    "    console.log(",
    "full trade close reservation cleanup",
)

trade = replace_once(
    trade,
    "    activeTrades.delete(tradeKey);\n"
    "    return response;",
    "    activeTrades.delete(tradeKey);\n"
    "    await releaseExecution(executionReservationHash, 'released');\n"
    "    return response;",
    "post-fill emergency flatten cleanup",
)

trade = replace_once(
    trade,
    "  if (!orderFillTransaction) {\n"
    "    const rejectReason =\n"
    "      'No fill transaction in OANDA response — IOC order found no liquidity';",
    "  if (!orderFillTransaction) {\n"
    "    await releaseExecution(executionReservationHash, 'no_fill');\n"
    "    const rejectReason =\n"
    "      'No fill transaction in OANDA response — IOC order found no liquidity';",
    "V3/PPR no-fill reservation cleanup",
)

for marker in [
    "releaseExecutionByTradeId",
    "releaseExecutionsForPairDirection",
    "statuses: ['open']",
    "[STALE RESERVATION RELEASED]",
    "await releaseExecution(executionReservationHash, 'no_fill')",
    "await releaseExecutionByTradeId(tradeId, 'released')",
]:
    if marker not in trade:
        raise RuntimeError(f"stale reservation oandaTrade patch incomplete: missing {marker}")

TRADE.write_text(trade, encoding="utf-8")


ict = ICT.read_text(encoding="utf-8")
if "await releaseExecution(params.__reservationHash, 'no_fill')" not in ict:
    ict = replace_once(
        ict,
        "  if (!fill) {\n"
        "    rec('rejected: no fill transaction (IOC found no liquidity)');",
        "  if (!fill) {\n"
        "    if (params.__reservationHash) await releaseExecution(params.__reservationHash, 'no_fill');\n"
        "    rec('rejected: no fill transaction (IOC found no liquidity)');",
        "ICT no-fill reservation cleanup",
    )

if "await releaseExecution(params.__reservationHash, 'no_fill')" not in ict:
    raise RuntimeError("stale reservation ICT patch incomplete")
if "params.__entryCycleReservationHash" in ict and "await releaseExecution(params.__entryCycleReservationHash, 'no_fill')" not in ict:
    raise RuntimeError("stale reservation ICT H1-cycle cleanup incomplete")

ICT.write_text(ict, encoding="utf-8")
print("Stale open execution reservations release without clearing in-flight reserved orders")
