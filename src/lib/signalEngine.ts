import type { TradeSignal } from '../services/alpacaLiveTrading';

console.log("🔥 signalEngine ACTIVE");

export type AlpacaAISignalStatus =
  | 'qualified'
  | 'insufficient_data'
  | 'market_closed'
  | 'NO_VALID_OPTION'
  | 'AI_UNAVAILABLE';

export type AlpacaAISignal = TradeSignal & {
  ticker: string;
  symbol: string;
  optionSymbol: string;
  score: number;
  totalScore: number;
  confidence: number;
  repeatabilityScore: number;
  grade: 'A+' | 'A' | 'B';
  riskReward: number;
  marketAlignment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  bias: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  entry: number;
  limitPrice: number;
  stop: number;
  target: number;
  source: 'alpaca';
  isLive: true;
  status: AlpacaAISignalStatus;
  reason: string;
  catalyst?: string;
  aiDecision?: 'APPROVE' | 'REJECT';
};

export type AlpacaAIScanStatus = {
  status: 'open' | 'closed' | 'insufficient_data' | 'error';
  message: string;
  reviewed: number;
  qualified: number;
  rejected: number;
};

type StockSnapshot = {
  symbol: string;
  latestPrice: number | null;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  dailyVolume: number | null;
  minuteBarClose: number | null;
  dailyOpen: number | null;
  dailyHigh: number | null;
  dailyLow: number | null;
  previousClose: number | null;
  percentChange: number | null;
  spread: number | null;
  timestamp: string | null;
};

type OptionContract = {
  underlying: string;
  optionSymbol: string;
  expirationDate: string;
  strikePrice: number | null;
  type: string;
  status: string;
  tradable: boolean;
  rootSymbol: string;
};

type OptionSnapshot = {
  optionSymbol: string;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  lastPrice: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  timestamp: string | null;
};

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_URL ||
  'http://localhost:3001';

const MIN_TOTAL_SCORE = 14;
const MIN_CONFIDENCE = 65;
const MIN_RISK_REWARD = 1.6;
const MIN_REPEATABILITY = 50;

let lastScanStatus: AlpacaAIScanStatus = {
  status: 'insufficient_data',
  message: 'Alpaca AI has not scanned yet',
  reviewed: 0,
  qualified: 0,
  rejected: 0,
};

function isMarketOpenET(now = new Date()): boolean {
  const et = new Date(
    now.toLocaleString('en-US', {
      timeZone: 'America/New_York',
    }),
  );

  const day = et.getDay();

  if (day === 0 || day === 6) return false;

  const minutes = et.getHours() * 60 + et.getMinutes();

  return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
}

function round(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function gradeFromScore(score: number): 'A+' | 'A' | 'B' {
  if (score >= 18) return 'A+';
  if (score >= 15) return 'A';
  return 'B';
}

function calcRepeatability(
  score: number,
  confidence: number,
  riskReward: number,
  spreadPct: number,
  dailyVolume: number,
): number {

  let repeatability = 0;

  repeatability += score * 2.8;
  repeatability += confidence * 0.32;
  repeatability += Math.min(riskReward * 6, 18);

  if (spreadPct <= 0.1) repeatability += 10;
  else if (spreadPct <= 0.25) repeatability += 6;
  else if (spreadPct <= 0.5) repeatability += 3;

  if (dailyVolume >= 10_000_000) repeatability += 12;
  else if (dailyVolume >= 5_000_000) repeatability += 8;
  else if (dailyVolume >= 1_000_000) repeatability += 5;

  return Math.min(100, Math.round(repeatability));
}

function emptySignal(
  symbol: string,
  status: AlpacaAISignalStatus,
  reason: string,
): AlpacaAISignal {

  return {
    ticker: symbol,
    symbol,
    optionSymbol: '',
    limitPrice: 0,
    score: 0,
    totalScore: 0,
    confidence: 0,
    repeatabilityScore: 0,
    grade: 'B',
    riskReward: 0,
    marketAlignment: 'NEUTRAL',
    bias: 'NEUTRAL',
    entry: 0,
    stop: 0,
    target: 0,
    source: 'alpaca',
    isLive: true,
    status,
    reason,
    aiDecision: 'REJECT',
  };
}

async function getJson<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {

  if (!API_BASE) {
    throw new Error('VITE_API_URL is not configured');
  }

  const search = new URLSearchParams(params);

  const response = await fetch(
    `${API_BASE}${path}?${search.toString()}`
  );

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const message =
      typeof body?.error === 'string'
        ? body.error
        : `Alpaca API request failed (${response.status})`;

    throw new Error(message);
  }

  return body as T;
}

async function fetchSnapshots(
  symbols: string[],
): Promise<StockSnapshot[]> {

  const snapshots: StockSnapshot[] = [];

  for (const group of chunk(symbols, 100)) {
    const body = await getJson<{
      snapshots: StockSnapshot[];
    }>(
      '/api/alpaca/market/snapshots',
      {
        symbols: group.join(','),
      },
    );

    snapshots.push(...(body.snapshots || []));
  }

  return snapshots;
}

function scoreSnapshot(snapshot: StockSnapshot): AlpacaAISignal {
  const price =
    snapshot.latestPrice ??
    snapshot.minuteBarClose ??
    snapshot.dailyClose ??
    snapshot.previousClose ??
    0;

  const previousClose =
    snapshot.previousClose ??
    snapshot.dailyClose ??
    price;

  console.log("SNAPSHOT PRICE CHECK", {
    symbol: snapshot.symbol,
    latestPrice: snapshot.latestPrice,
    minuteBarClose: snapshot.minuteBarClose,
    dailyClose: snapshot.dailyClose,
    previousClose: snapshot.previousClose,
    finalPrice: price,
  });

  if (!price || !previousClose || price <= 0 || previousClose <= 0) {
    console.log("SCORE DEBUG:", { symbol: snapshot.symbol, score: 0, confidence: 0 });
    return emptySignal(snapshot.symbol, 'insufficient_data', 'Missing Alpaca pricing data');
  }

  const rawBid = snapshot.bid;
  const rawAsk = snapshot.ask;

  // When live quotes are unavailable (outside market hours, stale IEX feed),
  // synthesize a conservative spread so the signal can still be scored from
  // price/volume/momentum data rather than being dropped entirely.
  let bid: number;
  let ask: number;
  let syntheticSpread: boolean;

  if (!rawBid || !rawAsk || rawAsk <= rawBid) {
    bid = price * 0.999;
    ask = price * 1.001;
    syntheticSpread = true;
  } else {
    bid = rawBid;
    ask = rawAsk;
    syntheticSpread = false;
  }

  const percentChange =
    snapshot.percentChange ??
    ((price - previousClose) / previousClose) * 100;

  // Use real spread when available; synthetic 0.2% estimate otherwise
  const spread = syntheticSpread ? price * 0.002 : (snapshot.spread ?? ask - bid);
  const spreadPct = syntheticSpread ? 0.2 : (spread / price) * 100;

  const dailyVolume = snapshot.dailyVolume ?? 0;
  const minuteVolume = snapshot.volume ?? 0;

  const dailyOpen = snapshot.dailyOpen ?? previousClose;
  const minuteClose = snapshot.minuteBarClose ?? price;

  if (spreadPct > 1.25) {
    console.log("SCORE DEBUG:", { symbol: snapshot.symbol, score: 0, confidence: 0 });
    return emptySignal(snapshot.symbol, 'insufficient_data', `Spread too wide (${round(spreadPct)}%)`);
  }

  let score = 0;

  // Liquidity
  score +=
    dailyVolume >= 10_000_000 ? 5 :
    dailyVolume >= 5_000_000 ? 4 :
    dailyVolume >= 1_000_000 ? 3 :
    dailyVolume >= 250_000 ? 1 :
    0;

  // Momentum
  score +=
    percentChange >= 2 ? 5 :
    percentChange >= 1 ? 4 :
    percentChange >= 0.5 ? 3 :
    percentChange > 0 ? 2 :
    0;

  // 🔥 Repeatability boost (DO NOT REMOVE EXISTING LOGIC)
  if (dailyVolume > 8_000_000) score += 2;
  if (Math.abs(percentChange) > 1.5) score += 2;

  // Intraday strength
  score +=
    minuteClose >= dailyOpen && price >= minuteClose
      ? 4
      : price >= dailyOpen
        ? 2
        : 0;

  // Tight spreads — synthetic spread (no live quote) scores 1, real spread scored normally
  score +=
    syntheticSpread ? 1 :
    spreadPct <= 0.08 ? 4 :
    spreadPct <= 0.15 ? 3 :
    spreadPct <= 0.35 ? 2 :
    1;

  // Active intraday volume
  score +=
    minuteVolume >= 50_000 ? 3 :
    minuteVolume >= 20_000 ? 2 :
    minuteVolume >= 5_000 ? 1 :
    0;

  // Valid range structure
  if (
    snapshot.dailyHigh &&
    snapshot.dailyLow &&
    snapshot.dailyHigh > snapshot.dailyLow
  ) {
    score += 1;
  }

  const marketAlignment: AlpacaAISignal['marketAlignment'] =
    percentChange >= 0.3
      ? 'BULLISH'
      : percentChange <= -0.3
        ? 'BEARISH'
        : 'NEUTRAL';

  const stop = round(price * 0.985);

  const targetMove = Math.max(
    price * 0.03,
    Math.abs(price - previousClose) * 1.75,
  );

  const target = round(price + targetMove);

  const riskReward =
    stop < price
      ? round((target - price) / (price - stop), 2)
      : 0;

  const confidence = Math.min(
    97,
    Math.round(
      48 +
      score * 2.5 +
      (dailyVolume >= 5_000_000 ? 8 : 0)
    ),
  );

  const repeatabilityScore = calcRepeatability(
    score,
    confidence,
    riskReward,
    spreadPct,
    dailyVolume,
  );

  const grade = gradeFromScore(score);

  // Normalize score to 0-20 range (no artificial bumps — real value only)
  const normalizedScore = (!score || isNaN(score)) ? 0 : Math.min(20, score);

  // Confidence proportional to score: score 15 → 75%, score 20 → 100%
  const normalizedConfidence = Math.min(100, Math.round((normalizedScore / 20) * 100));

  console.log("SCORE DEBUG:", {
    symbol:     snapshot.symbol,
    score:      normalizedScore,
    confidence: normalizedConfidence,
  });

  const signal: AlpacaAISignal = {
    ticker: snapshot.symbol,
    symbol: snapshot.symbol,
    optionSymbol: '',
    limitPrice: 0,
    score:            normalizedScore,
    totalScore:       normalizedScore,
    confidence:       normalizedConfidence,
    repeatabilityScore,
    grade,
    riskReward,
    marketAlignment,
    bias: marketAlignment,
    entry: round(price),
    stop,
    target,
    source: 'alpaca',
    isLive: true,
    status: 'qualified',
    reason: 'Qualified from Alpaca live market structure scan',
    catalyst:
      percentChange >= 2
        ? 'Strong momentum breakout'
        : percentChange >= 1
          ? 'Intraday continuation setup'
          : 'Momentum developing',
    aiDecision: 'APPROVE',
  };

  const isNearMiss =
  normalizedConfidence >= MIN_CONFIDENCE - 5 &&
  repeatabilityScore >= MIN_REPEATABILITY - 5 &&
  riskReward >= 1.6;

  const rejectedReasons: string[] = [];

  if (normalizedScore < MIN_TOTAL_SCORE)
    rejectedReasons.push(`score ${normalizedScore} < ${MIN_TOTAL_SCORE}`);

  if (!isNearMiss && normalizedConfidence < MIN_CONFIDENCE)
    rejectedReasons.push(`conf ${normalizedConfidence} < ${MIN_CONFIDENCE}`);

  if (!isNearMiss && riskReward < MIN_RISK_REWARD)
    rejectedReasons.push(`rr ${round(riskReward, 2)} < ${MIN_RISK_REWARD}`);

  if (!isNearMiss && repeatabilityScore < MIN_REPEATABILITY)
    rejectedReasons.push(`rep ${repeatabilityScore} < ${MIN_REPEATABILITY}`);

  // Do not reject bearish moves outright.
  // Bearish alignment can still produce PUT signals.
  // if (marketAlignment === 'BEARISH')
  //   rejectedReasons.push('BEARISH alignment');

  if (rejectedReasons.length > 0) {
    console.log("SIGNAL REJECTED", {
      symbol: snapshot.symbol,
      score: normalizedScore,
      confidence: normalizedConfidence,
      repeatabilityScore,
      riskReward,
      reasons: rejectedReasons,
    });

    return {
      ...signal,
      status: 'insufficient_data',
      aiDecision: 'REJECT',
      reason: `Rejected: ${rejectedReasons.join(', ')}`,
    };
  }

  console.log("SCORE GENERATED:", { symbol: snapshot.symbol, score: signal.score, confidence: signal.confidence });
  return {
    ...signal,
    reason: syntheticSpread
      ? 'Qualified — live quote unavailable, scored from price/volume data'
      : 'Qualified from Alpaca live market structure scan',
  };
}

async function fetchOptionContracts(
  signal: TradeSignal,
): Promise<OptionContract[]> {

  const body = await getJson<{
    contracts: OptionContract[];
  }>(
    '/api/alpaca/options/contracts',
    {
      underlying: signal.ticker,
      type: 'call',
      underlyingPrice: String(signal.entry),
    },
  );

  return body.contracts || [];
}

async function fetchOptionSnapshots(
  symbols: string[],
): Promise<OptionSnapshot[]> {

  if (!symbols.length) return [];

  const snapshots: OptionSnapshot[] = [];

  for (const group of chunk(symbols, 100)) {
    const body = await getJson<{
      snapshots: OptionSnapshot[];
    }>(
      '/api/alpaca/options/snapshots',
      {
        symbols: group.join(','),
      },
    );

    snapshots.push(...(body.snapshots || []));
  }

  return snapshots;
}

function optionQuality(snapshot: OptionSnapshot): number {

  const bid = snapshot.bid ?? 0;
  const ask = snapshot.ask ?? 0;
  const mid = snapshot.mid ?? 0;

  if (bid <= 0 || ask <= bid || mid <= 0) {
    return -1;
  }

  const spreadPct = (ask - bid) / mid;

  if (spreadPct > 0.35) {
    return -1;
  }

  const volume = snapshot.volume ?? 0;
  const openInterest = snapshot.openInterest ?? 0;
  const delta = Math.abs(snapshot.delta ?? 0);

  let score = 0;

  score +=
    spreadPct <= 0.1 ? 5 :
    spreadPct <= 0.18 ? 4 :
    spreadPct <= 0.25 ? 2 :
    1;

  score +=
    volume >= 1000 ? 5 :
    volume >= 500 ? 4 :
    volume >= 100 ? 2 :
    volume > 0 ? 1 :
    0;

  score +=
    openInterest >= 3000 ? 5 :
    openInterest >= 1000 ? 4 :
    openInterest >= 250 ? 2 :
    openInterest > 0 ? 1 :
    0;

  score +=
    delta >= 0.25 && delta <= 0.65
      ? 4
      : delta > 0
        ? 1
        : 0;

  score +=
    mid <= 5 ? 3 :
    mid <= 10 ? 2 :
    1;

  return score;
}

export async function selectSmallOptionsCandidate(
  signal: AlpacaAISignal,
): Promise<AlpacaAISignal> {

  const contracts = await fetchOptionContracts(signal);
  console.log("OPTION CONTRACTS:", contracts.length, signal.ticker);

  if (!contracts.length) {
    return {
      ...signal,
      optionSymbol: `SIM_${signal.ticker}`,
      limitPrice: Math.max(1, signal.entry * 0.02),
      status: 'qualified',
      aiDecision: 'APPROVE',
      reason: 'Fallback option (no contracts)',
    };
  }

  const optionSymbols = contracts
    .slice(0, 30)
    .map(contract => contract.optionSymbol);

  const snapshots = await fetchOptionSnapshots(optionSymbols);

  const bySymbol = new Map(
    snapshots.map(snapshot => [
      snapshot.optionSymbol,
      snapshot,
    ]),
  );

  const ranked = contracts
    .map(contract => {
      const snapshot = bySymbol.get(contract.optionSymbol);

      return snapshot
        ? {
            contract,
            snapshot,
            score: optionQuality(snapshot),
          }
        : null;
    })
    .filter(
      (
        item,
      ): item is {
        contract: OptionContract;
        snapshot: OptionSnapshot;
        score: number;
      } => Boolean(item && item.score >= 0),
    )
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  console.log("BEST CONTRACT:", best?.contract?.optionSymbol ?? 'none', 'score:', best?.score ?? 'n/a');
  if (best && best.score < 50) {
    console.warn('Low quality option selected:', best.contract.optionSymbol);
  }

  if (!best || !best.snapshot.mid) {
    const fallback = contracts[0];

    return {
      ...signal,
      optionSymbol: fallback.optionSymbol,
      limitPrice: Math.max(1, signal.entry * 0.02),
      status: 'qualified',
      aiDecision: 'APPROVE',
      reason: 'Fallback option (no liquidity)',
    };
  }

  const result: AlpacaAISignal = {
    ...signal,
    optionSymbol: best.contract.optionSymbol,
    limitPrice: round(best.snapshot.mid),
    status: 'qualified',
    aiDecision: 'APPROVE',
    reason: `Selected high-liquidity Alpaca option contract expiring ${best.contract.expirationDate}`,
  };
  console.log("OPTION RESULT:", result.optionSymbol, result.limitPrice);
  return result;
}

export function getAlpacaAIScanStatus(): AlpacaAIScanStatus {
  return lastScanStatus;
}

export async function generateAlpacaAISignals(
  symbols: string[],
): Promise<TradeSignal[]> {

  console.log("🔥 generateAlpacaAISignals RUNNING");
  console.log("INPUT SYMBOLS:", symbols.length);

  const candidates = symbols
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean);

  console.log("CANDIDATES:", candidates.length);

  if (!candidates.length) {
    lastScanStatus = {
      status: 'insufficient_data',
      message: 'No Alpaca symbols available for scan',
      reviewed: 0,
      qualified: 0,
      rejected: 0,
    };
    return [];
  }

  try {

    const BATCH_SIZE = 2500;
    let snapshots: StockSnapshot[] = [];

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const batchSnapshots = await fetchSnapshots(batch);
      snapshots = snapshots.concat(batchSnapshots);
    }

    console.log("SNAPSHOTS:", snapshots.length);

    const reviewed = snapshots.map(scoreSnapshot);

    console.log("REVIEWED TOTAL:", reviewed.length);

    // Per-signal diagnostics
    reviewed.forEach(signal => {
      console.log("SIGNAL CHECK", {
        ticker: signal.ticker,
        confidence: signal.confidence,
        repeatabilityScore: signal.repeatabilityScore,
        riskReward: signal.riskReward,
        status: signal.status,
        grade: signal.grade,
        reason: signal.reason,
      });
    });

    // Aggregate range diagnostics
    const withData = reviewed.filter(s => s.confidence > 0);
    if (withData.length > 0) {
      const confs = withData.map(s => s.confidence);
      const reps  = withData.map(s => s.repeatabilityScore);
      const rrs   = withData.map(s => s.riskReward);
      console.log("CONFIDENCE RANGE:",   Math.min(...confs), '→', Math.max(...confs));
      console.log("REPEATABILITY RANGE:", Math.min(...reps),  '→', Math.max(...reps));
      console.log("RISK/REWARD RANGE:",  Math.min(...rrs),   '→', Math.max(...rrs));
    } else {
      console.warn("ALL REVIEWED SIGNALS HAVE CONFIDENCE=0 — bid/ask null for entire batch (market closed / IEX feed stale)");
    }
    console.log("REVIEWED WITH ENTRY>0:", reviewed.filter(s => s.entry > 0).length, "/", reviewed.length);

    // CHANGE 1 — small-cap priority boost (soft, no hard filter)
    const enhanced = reviewed.map(signal => ({
      ...signal,
      enhancedScore:
        (signal.repeatabilityScore ?? 0) * 0.6 +
        (signal.confidence ?? 0) * 0.4 *
        (signal.entry > 0 && signal.entry < 50 ? 1.25 : 1.0),
    }));

    // CHANGE 2 — sort by enhanced score, no filtering
    const sorted = [...enhanced].sort(
      (a, b) => (b.enhancedScore ?? 0) - (a.enhancedScore ?? 0)
    );

    const qualified = sorted
      .filter(s =>
      (s.totalScore ?? s.score ?? 0) >= 14 &&
      (s.confidence ?? 0) >= 65
    )
    .slice(0, 50);

    console.log("QUALIFIED COUNT:", qualified.length, "/", sorted.length);
    console.log("QUALIFIED SAMPLE:", qualified.slice(0, 10).map(s => ({
    ticker: s.ticker,
      score: s.score,
      confidence: s.confidence,
      repeatabilityScore: s.repeatabilityScore,
      riskReward: s.riskReward,
      status: s.status,
      reason: s.reason,
    })));

    // Assign option symbols only to qualified signals
    const withOptions = await Promise.all(
      qualified.map(async signal => {
        try {
          const result = await selectSmallOptionsCandidate(signal);

          console.log("OPTION RESULT:", {
            ticker: signal.ticker ?? signal.symbol,
            status: result.status,
            optionSymbol: result.optionSymbol,
            limitPrice: result.limitPrice,
            confidence: result.confidence,
            repeatabilityScore: result.repeatabilityScore,
            riskReward: result.riskReward,
          });

          return result;
        } catch (err) {
          console.warn("OPTION LOOKUP FAILED:", signal.ticker, err instanceof Error ? err.message : err);
          return {
          ...signal,
          optionSymbol: undefined,
          limitPrice: 0,
          status: 'rejected' as const,
          aiDecision: 'REJECT' as const,
          reason: 'Option lookup failed — rejected, no fallback contract',
        };
      }
    })
  );

  let executable = withOptions
  .filter(signal =>
    (signal.totalScore ?? signal.score ?? 0) >= 14 &&
    (signal.confidence ?? 0) >= 65 &&
    !!signal.optionSymbol &&
    (signal.limitPrice ?? 0) > 0
  )
  .slice(0, 25);

    console.log("FILTER RESULTS:", {
      totalSignals: withOptions.length,
      passedFilter: executable.length,
      sample: withOptions.slice(0, 5).map(s => ({
        symbol: s.symbol,
        score: s.score,
        confidence: s.confidence
      }))
    });

    // CHANGE 7 — debug visibility
    console.log("TOP SIGNALS:", executable.map(s => ({
      ticker: s.ticker,
      entry: s.entry,
      optionSymbol: s.optionSymbol,
      limitPrice: s.limitPrice,
      confidence: s.confidence,
      repeatabilityScore: s.repeatabilityScore,
    })));
    console.log("EXECUTABLE SIGNALS:", executable.length);
    console.log("FINAL EXECUTABLE:", executable.length);
    console.log("🔥 Executable signals:", executable.length);

    const marketClosed = !isMarketOpenET();

    lastScanStatus = {
      status:
        executable.length
          ? (marketClosed ? 'closed' : 'open')
          : marketClosed
            ? 'closed'
            : 'insufficient_data',

      message:
        executable.length
          ? marketClosed
            ? 'Market closed — using latest Alpaca market data'
            : 'Alpaca AI generated live repeatability-ranked signals'
          : marketClosed
            ? 'Market closed — no qualifying signals'
            : 'No qualifying repeatable Alpaca signals found',

      reviewed: reviewed.length,
      qualified: executable.length,
      rejected: reviewed.length - executable.length,
    };

    console.log("EXECUTABLE DATA:", executable);
    return executable;

  } catch (err) {

    lastScanStatus = {
      status: 'error',
      message:
        err instanceof Error
          ? err.message
          : 'Alpaca AI market scan failed',
      reviewed: 0,
      qualified: 0,
      rejected: 0,
    };

    throw err;
  }
}

export default generateAlpacaAISignals;
