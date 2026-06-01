/**
 * web/lib/edgeSnapshot.ts
 *
 * Signal Stack V3 — build an EdgeSnapshotInput from a scanner signal at trade
 * open. Mirrors server/edgeIntelligence.js#buildTradeEdgeSnapshot, but typed
 * for the TS side and limited to the entry-time conditions available in the
 * `signal` payload the dashboard sends with a trade.
 *
 * Purely additive: the output is fed to logTradeEvent({ edge }) so the
 * Edge Intelligence dashboard can attribute performance later. It never
 * influences whether or how a trade is placed.
 */

import 'server-only';
import type { EdgeSnapshotInput } from './tradeLogs';

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

type MacroAnalysis = { risk?: unknown; bias?: unknown } | undefined;
type MarketRegime = { regime?: unknown; volatility?: { state?: unknown } | string } | undefined;

/**
 * Extract the entry-condition snapshot from a signal. Tolerates a fully or
 * partially populated signal (V3 fields may be absent on older clients).
 */
export function edgeSnapshotFromSignal(signal: Record<string, unknown>): EdgeSnapshotInput {
  const macro = signal.macroAnalysis as MacroAnalysis;
  const regime = signal.marketRegime as MarketRegime;

  const direction =
    signal.direction === 'long' || signal.direction === 'short' ? signal.direction : null;

  let volatility: string | null = null;
  if (regime && typeof regime.volatility === 'object' && regime.volatility) {
    volatility = str((regime.volatility as { state?: unknown }).state);
  } else if (regime && typeof regime.volatility === 'string') {
    volatility = regime.volatility;
  }
  volatility = volatility ?? str(signal.volatilityState);

  return {
    pair: str(signal.pair),
    direction,
    session: str(signal.session),
    spread: num(signal.spreadPips),
    signalScore: num(signal.score),
    trend: str(signal.trend),
    volatility,
    marketRegime: regime ? str(regime.regime) : null,
    macroBias: macro ? str(macro.bias) : null,
    macroRisk: macro ? str(macro.risk) : null,
  };
}
