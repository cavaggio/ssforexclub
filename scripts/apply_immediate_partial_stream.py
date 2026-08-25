#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


# ---------------------------------------------------------------------------
# Immediate stream module: expose per-trade stream state to the legacy
# reconciliation manager so polling can remain a disconnected-stream fallback
# without racing an in-flight event-driven partial.
# ---------------------------------------------------------------------------
path = ROOT / 'server' / 'oandaImmediatePartial.js'
text = path.read_text(encoding='utf-8')
anchor = """export function isImmediatePartialTaken({ accountId, tradeId } = {}) {
  const id = String(tradeId || '');
  const account = [...accounts.values()].find((item) => item.accountId === String(accountId || ''));
  return account?.trades.get(id)?.partialTaken === true;
}

"""
replacement = anchor + """export function getImmediatePartialTradeState({ accountId, tradeId } = {}) {
  const id = String(tradeId || '');
  const account = [...accounts.values()].find((item) => item.accountId === String(accountId || ''));
  const state = account?.trades.get(id);
  if (!account || !state) return null;
  return {
    registered: true,
    connected: account.connected === true,
    partialTaken: state.partialTaken === true,
    partialInFlight: state.partialInFlight === true,
    maxProfitPips: Number(state.maxProfitPips || 0),
    lastPartialAt: state.lastPartialAt ?? null,
  };
}

"""
text = replace_once(text, anchor, replacement, 'immediate stream state export')
path.write_text(text, encoding='utf-8')


# ---------------------------------------------------------------------------
# Legacy exit manager: stream is authoritative while connected; 30-second
# partial evaluation remains only as a fail-safe if the stream is unavailable.
# Breakeven/trailing/final-exit cadence remains unchanged.
# ---------------------------------------------------------------------------
path = ROOT / 'server' / 'oandaExitManager.js'
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { getPricing } from './oandaMarketData.js';\n",
    """import { getPricing } from './oandaMarketData.js';
import {
  getImmediatePartialTradeState,
  markImmediatePartialTaken,
  syncImmediatePartialTrades,
  getImmediatePartialStatus,
} from './oandaImmediatePartial.js';
""",
    'exit manager immediate stream import',
)
text = text.replace(
    ' *   B. 50% partial close at +PARTIAL_CLOSE_TRIGGER_PIPS\n',
    ' *   B. Event-driven 50% partial at +PARTIAL_CLOSE_TRIGGER_PIPS (polling is disconnect fallback only)\n',
    1,
)
old_partial = """  // ── B. Partial close at +15.0 pips (50%) ─────────────────────────────────────────
  if (!state.partialTaken && profitPips >= PARTIAL_CLOSE_TRIGGER_PIPS) {
    if (totalUnits < 2) {
      // Can't split a single-unit position — mark as taken to suppress repeat attempts
      state.partialTaken   = true;
      state.trailingActive = true;
      console.log('[OANDA_PARTIAL_CLOSE_50] Skipped — position too small to split', { tradeId, totalUnits });
    } else {
      // Close exactly 50%, leave at least 1 unit as runner
      const unitsToClose = Math.max(1, Math.min(
        Math.round(totalUnits * PARTIAL_CLOSE_PERCENT),
        totalUnits - 1
      ));
      const remaining = totalUnits - unitsToClose;
      try {
        await partialClosePosition(tradeId, unitsToClose);
        state.partialTaken   = true;
        state.trailingActive = true;
        console.log('[OANDA_PARTIAL_CLOSE_50]', {
          tradeId, instrument,
          direction:    isLong ? 'LONG' : 'SHORT',
          totalUnits,
          closedUnits:  unitsToClose,
          runnerUnits:  remaining,
          profitPips:   +profitPips.toFixed(1),
        });
      } catch (err) {
        console.error('[OANDA_PARTIAL_CLOSE_50] Failed:', err.message);
      }
    }
  }
"""
new_partial = """  // ── B. Event-driven partial; polling is stream-disconnect fallback only ─────────────
  const immediatePartial = getImmediatePartialTradeState({
    accountId: getAccountId(),
    tradeId,
  });
  if (!state.partialTaken && immediatePartial?.partialTaken) {
    state.partialTaken = true;
    state.trailingActive = true;
    console.log('[OANDA_PARTIAL_CLOSE_50] synchronized from pricing stream', {
      tradeId,
      instrument,
      maxProfitPips: immediatePartial.maxProfitPips,
      lastPartialAt: immediatePartial.lastPartialAt,
    });
  }

  const streamOwnsTrigger = immediatePartial?.connected === true || immediatePartial?.partialInFlight === true;
  if (!state.partialTaken && !streamOwnsTrigger && profitPips >= PARTIAL_CLOSE_TRIGGER_PIPS) {
    console.warn('[OANDA_PARTIAL_CLOSE_50] pricing stream unavailable — using 30s safety fallback', {
      tradeId, instrument, profitPips: +profitPips.toFixed(1),
    });
    if (totalUnits < 2) {
      state.partialTaken   = true;
      state.trailingActive = true;
      markImmediatePartialTaken({ accountId: getAccountId(), tradeId, currentUnits });
      console.log('[OANDA_PARTIAL_CLOSE_50] Skipped — position too small to split', { tradeId, totalUnits });
    } else {
      const unitsToClose = Math.max(1, Math.min(
        Math.round(totalUnits * PARTIAL_CLOSE_PERCENT),
        totalUnits - 1
      ));
      const remaining = totalUnits - unitsToClose;
      try {
        await partialClosePosition(tradeId, unitsToClose);
        state.partialTaken   = true;
        state.trailingActive = true;
        const signedRemaining = (isLong ? 1 : -1) * remaining;
        markImmediatePartialTaken({ accountId: getAccountId(), tradeId, currentUnits: signedRemaining });
        console.log('[OANDA_PARTIAL_CLOSE_50]', {
          tradeId, instrument,
          direction:    isLong ? 'LONG' : 'SHORT',
          totalUnits,
          closedUnits:  unitsToClose,
          runnerUnits:  remaining,
          profitPips:   +profitPips.toFixed(1),
          source:       'polling_disconnect_fallback',
        });
      } catch (err) {
        console.error('[OANDA_PARTIAL_CLOSE_50] Failed:', err.message);
      }
    }
  }
"""
text = replace_once(text, old_partial, new_partial, 'exit manager partial block')
text = replace_once(
    text,
    """  if (!openTrades.length) {
    return; // Nothing to monitor
  }

  // Fetch live mid prices for all instruments in one batch call
""",
    """  // Reconcile the event-driven +15 pip stream from the broker snapshot.
  // This call discovers/re-discovers open trades, but PRICE events — not this
  // 30-second loop — own the live partial trigger while the stream is connected.
  syncImmediatePartialTrades(openTrades);

  if (!openTrades.length) {
    return; // Nothing to monitor
  }

  // Fetch live mid prices for all instruments in one batch call
""",
    'exit manager stream sync',
)
text = replace_once(
    text,
    """    pollIntervalMs: MONITOR_INTERVAL_MS,
    trackedTrades:  tradeState.size,
    trades,
""",
    """    pollIntervalMs: MONITOR_INTERVAL_MS,
    partialTriggerMode: 'oanda_pricing_stream_with_poll_disconnect_fallback',
    immediatePartialStream: getImmediatePartialStatus(),
    trackedTrades:  tradeState.size,
    trades,
""",
    'exit manager status',
)
path.write_text(text, encoding='utf-8')


# ---------------------------------------------------------------------------
# Trade executor: register each confirmed fill immediately with its request-
# scoped OANDA client. This removes any wait for an open-trade discovery poll.
# ---------------------------------------------------------------------------
path = ROOT / 'server' / 'oandaTrade.js'
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { buildOandaMarketOrderPayload, repriceExecutableGeometry, validateDirectionLock } from './v3EntryContract.js';\n",
    """import { buildOandaMarketOrderPayload, repriceExecutableGeometry, validateDirectionLock } from './v3EntryContract.js';
import { registerImmediatePartialTrade } from './oandaImmediatePartial.js';
""",
    'trade executor immediate partial import',
)
text = replace_once(
    text,
    """  console.log(
    `[TRADE] ✓ FILLED + SL/TP attached — tradeId=${tradeId}, price=${fillPrice}, ` +
    `actualRR=${actualFillRR.toFixed(2)}, tpAdjusted=${postFillTpAdjusted}, ` +
    `marginRequired=$${tradeMarginUsed.toFixed(2)}`
  );

  executionLog.push(logEntry('ORDER_FILL', {
""",
    """  const immediatePartialRegistration = tradeId
    ? registerImmediatePartialTrade({
        tradeId,
        instrument: pair,
        entryPrice: fillPrice,
        currentUnits: units,
        initialUnits: units,
        client,
      })
    : { registered: false, reason: 'missing_trade_id' };
  executionLog.push(logEntry('IMMEDIATE_PARTIAL_STREAM_REGISTER', immediatePartialRegistration));

  console.log(
    `[TRADE] ✓ FILLED + SL/TP attached — tradeId=${tradeId}, price=${fillPrice}, ` +
    `actualRR=${actualFillRR.toFixed(2)}, tpAdjusted=${postFillTpAdjusted}, ` +
    `marginRequired=$${tradeMarginUsed.toFixed(2)}, ` +
    `partialStream=${immediatePartialRegistration.registered ? 'registered' : 'unavailable'}`
  );

  executionLog.push(logEntry('ORDER_FILL', {
""",
    'trade executor stream registration',
)
path.write_text(text, encoding='utf-8')


# ---------------------------------------------------------------------------
# Reassessor: re-register open trades on authenticated management calls so a
# process restart can recover per-user streams. Also expose initial units to
# the scheduled route for duplicate-partial reconciliation.
# ---------------------------------------------------------------------------
path = ROOT / 'server' / 'oandaActiveTradeReassessor.js'
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    "import { getEnvironment, isLiveExecutionExplicitlyAllowed } from './oandaClient.js';\n",
    """import { getEnvironment, isLiveExecutionExplicitlyAllowed } from './oandaClient.js';
import { syncImmediatePartialTrades } from './oandaImmediatePartial.js';
""",
    'reassessor immediate stream import',
)
text = replace_once(
    text,
    """    direction: side,
    units: Math.abs(units),                              // absolute, for partial-close math
    assetClass: profile.assetClass,
""",
    """    direction: side,
    units: Math.abs(units),                              // absolute, for partial-close math
    initialUnits: Math.abs(Number(oandaTrade.initialUnits ?? historyRecord?.units ?? units)),
    assetClass: profile.assetClass,
""",
    'reassessor initial units',
)
text = replace_once(
    text,
    """  if (!openTrades.length) {
    return {
""",
    """  // Recovery path after a backend restart: authenticated reassessment
  // refreshes the account's live pricing-stream registrations.
  syncImmediatePartialTrades(openTrades, { client });

  if (!openTrades.length) {
    return {
""",
    'reassessor stream recovery sync',
)
path.write_text(text, encoding='utf-8')


# ---------------------------------------------------------------------------
# Scheduled active management: if the broker already shows reduced units while
# DB state still says no partial, reconcile that as the single partial before
# evaluating another close. This prevents the slower scheduled route from
# taking a second 50% after the stream already banked profit.
# ---------------------------------------------------------------------------
path = ROOT / 'web' / 'app' / 'api' / 'cron' / 'active-trade-management' / 'route.ts'
text = path.read_text(encoding='utf-8')
text = replace_once(
    text,
    """function runnerArmed(state: ExitState): boolean {
  const action = String(state.last_action || '').toUpperCase();
  return action === 'PARTIAL_RUNNER_ARMED' || action === 'RUNNER_ARMED' || action === 'TRAIL_PROFIT';
}

""",
    """function runnerArmed(state: ExitState): boolean {
  const action = String(state.last_action || '').toUpperCase();
  return action === 'PARTIAL_RUNNER_ARMED' || action === 'RUNNER_ARMED' || action === 'TRAIL_PROFIT';
}

function brokerAlreadyPartiallyReduced(plan: Record<string, any>): boolean {
  const initial = Math.abs(Number(plan.initialUnits));
  const current = Math.abs(Number(plan.units));
  return Number.isFinite(initial) && Number.isFinite(current) && initial > 0 && current > 0 && current < initial;
}

""",
    'active route broker reduction helper',
)
old = """        const previousState = stateByTrade.get(tradeId) ?? {};
        const decision = evaluateActiveExit(plan, {
          priorPartialCount: previousState.partial_count ?? 0,
          peakProfitR: previousState.peak_profit_r ?? null,
          peakProfitPips: previousState.peak_profit_pips ?? null,
          runnerArmed: runnerArmed(previousState),
          breakEvenSet: stopAtBreakeven(plan, previousState),
        }) as ManagementDecision;
"""
new = """        let previousState = stateByTrade.get(tradeId) ?? {};

        // The OANDA pricing stream can bank the +15 pip partial between cron
        // reviews. Reconcile broker-unit reduction before evaluating another
        // PARTIAL_CLOSE so the scheduled path cannot double-close the runner.
        if (Number(previousState.partial_count || 0) < 1 && brokerAlreadyPartiallyReduced(plan)) {
          const initialUnits = Math.abs(Number(plan.initialUnits));
          const currentUnits = Math.abs(Number(plan.units));
          const observedPercent = Math.max(1, Math.min(99, Math.round((1 - currentUnits / initialUnits) * 100)));
          const reconciliationDecision: ManagementDecision = {
            action: 'HOLD_TO_TP',
            closePercent: 0,
            reason: `Broker units are already reduced ${observedPercent}%; treating the +15 pip stream partial as banked before scheduled management.`,
            confidence: 99,
            policy: ACTIVE_EXIT_POLICY,
            automaticFullCloseAllowed: false,
            evidence: ['broker_units_already_reduced', 'stream_partial_reconciliation', 'single_partial_limit'],
            metrics: {
              initialUnits,
              currentUnits,
              observedPartialPercent: observedPercent,
              source: 'broker_unit_reconciliation',
            },
          };
          previousState = {
            ...previousState,
            partial_count: 1,
            cumulative_partial_percent: Math.max(
              Number(previousState.cumulative_partial_percent || 0),
              observedPercent,
            ),
            last_action: 'PARTIAL_STREAM_CONFIRMED',
            // Deliberately do not set last_action_at: the route may immediately
            // arm/protect the runner instead of waiting through the action cooldown.
            last_action_at: previousState.last_action_at ?? null,
          };
          await saveExitState({
            supabase, userId, accountId: credentials.accountId, tradeId,
            instrument: String(plan.instrument ?? ''), engine: tradeEngine,
            state: previousState, decision: reconciliationDecision,
            action: 'PARTIAL_STREAM_CONFIRMED', actionAt: null,
          });
          stateByTrade.set(tradeId, previousState);
          evaluations.push({
            tradeId,
            instrument: plan.instrument,
            engine: tradeEngine,
            action: 'PARTIAL_STREAM_CONFIRMED',
            observedPartialPercent: observedPercent,
            initialUnits,
            currentUnits,
          });
        }

        const decision = evaluateActiveExit(plan, {
          priorPartialCount: previousState.partial_count ?? 0,
          peakProfitR: previousState.peak_profit_r ?? null,
          peakProfitPips: previousState.peak_profit_pips ?? null,
          runnerArmed: runnerArmed(previousState),
          breakEvenSet: stopAtBreakeven(plan, previousState),
        }) as ManagementDecision;
"""
text = replace_once(text, old, new, 'active route stream partial reconciliation')
path.write_text(text, encoding='utf-8')


required = {
    ROOT / 'server' / 'oandaImmediatePartial.js': [
        'getImmediatePartialTradeState',
        'OANDA_PARTIAL_STREAM_50',
        'pricing/stream?instruments=',
    ],
    ROOT / 'server' / 'oandaExitManager.js': [
        "partialTriggerMode: 'oanda_pricing_stream_with_poll_disconnect_fallback'",
        'streamOwnsTrigger',
        'syncImmediatePartialTrades(openTrades)',
    ],
    ROOT / 'server' / 'oandaTrade.js': [
        'registerImmediatePartialTrade',
        'IMMEDIATE_PARTIAL_STREAM_REGISTER',
    ],
    ROOT / 'server' / 'oandaActiveTradeReassessor.js': [
        'syncImmediatePartialTrades(openTrades, { client })',
        'initialUnits: Math.abs(Number(oandaTrade.initialUnits',
    ],
    ROOT / 'web' / 'app' / 'api' / 'cron' / 'active-trade-management' / 'route.ts': [
        'brokerAlreadyPartiallyReduced',
        'PARTIAL_STREAM_CONFIRMED',
    ],
}
for file_path, markers in required.items():
    content = file_path.read_text(encoding='utf-8')
    missing = [marker for marker in markers if marker not in content]
    if missing:
        raise RuntimeError(f'{file_path}: missing markers {missing}')

print('Immediate +15 pip OANDA pricing-stream partial integration applied.')
