/**
 * web/types/ict.ts
 *
 * Types for the ICT Intelligence engine response (server/ictEngine.js). Shadow
 * analysis only — never an execution payload.
 */

export type IctDir = 'bullish' | 'bearish' | null;

export interface IctLiquidityLevel {
  label: string;
  kind?: 'high' | 'low';
  price: number;
  source: string;
  distancePips?: number | null;
  major?: boolean;
}

export interface IctLiquidityMap {
  buySideLiquidity: IctLiquidityLevel[];
  sellSideLiquidity: IctLiquidityLevel[];
  nearestLiquidity: IctLiquidityLevel | null;
  sweptLiquidity: { label: string; source: string; direction: IctDir } | null;
  remainingLiquidity: IctLiquidityLevel[];
}

export interface IctFVG {
  type: 'bullish' | 'bearish';
  timeframe: string;
  high: number;
  low: number;
  midpoint: number;
  sizePips?: number;
  status: 'open' | 'partial' | 'filled';
  qualityScore: number;
}

export interface IctConcepts {
  liquidityMap: IctLiquidityMap;
  sweep: { direction: IctDir; sweptLiquidity?: string; sweptSource?: string | null; sweptPriceLevel?: number; sweepStrength?: number } | null;
  displacement: { direction: IctDir; candleIndex: number | null; displacementScore: number; createdFVG: boolean };
  mss: { direction: IctDir; sweptLevel: number | null; brokenStructureLevel: number | null; confirmed: boolean };
  bos: { direction: IctDir; brokenLevel?: number } | null;
  choch: { direction: IctDir; brokenLevel?: number } | null;
  fvgs: IctFVG[];
  orderBlock: { type: IctDir; high: number | null; low: number | null; midpoint: number | null; strengthScore: number; mitigated: boolean };
  inducement: { inducementPresent: boolean; inducementSwept: boolean; trapDirection: string | null; level?: number };
  premiumDiscount: { dealingRangeHigh: number | null; dealingRangeLow: number | null; equilibrium: number | null; currentZone: 'premium' | 'discount' | 'equilibrium' | 'unknown'; pricePositionPct?: number };
  ote: { oteLow: number | null; oteHigh: number | null; priceInOTE: boolean; oteQuality: number };
  powerOf3: { phase: string; asianRange: { high: number; low: number } | null; manipulationSide: string | null; distributionDirection: IctDir };
  killzone: { currentKillzone: string | null; inKillzone: boolean; killzoneQuality: number };
  macro: { activeMacro: string | null; macroWindow: string | null; macroQuality: number };
  silverBullet: { activeWindow: boolean; direction: IctDir; fvgEntry: number | null; stopLoss: number | null; liquidityTarget: number | null; confidence: number };
  smt: { smtDetected: boolean; comparisonAsset: string | null; direction: IctDir; liquidityLevel: number | null; note?: string };
  turtleSoup: { turtleSoupDetected: boolean; direction: IctDir; sweptEqualLevel: number | null; reclaimConfirmed: boolean };
  judas: { judasSwingDetected: boolean; fakeMoveDirection: string | null; trueMoveDirection: string | null; asianRangeSwept: boolean };
  irlErl: { currentDraw: 'IRL' | 'ERL'; nextTarget: { label: string; price: number } | null; targetReason: string };
  dailyBias: { dailyBias: IctDir | 'neutral'; drawOnLiquidity: (IctLiquidityLevel & { side: string }) | null; confidence: number; reason: string };
}

export interface IctTiming {
  lateEntryRisk: 'low' | 'medium' | 'high' | null;
  distanceToTarget: number | null;
  distanceToStop: number | null;
  timingGrade: 'A' | 'B' | 'C' | 'D' | 'n/a';
}

export interface IctV3Comparison {
  v3Direction: 'long' | 'short' | null;
  v3Score: number;
  v3Qualified: boolean;
  ictDirection: 'long' | 'short' | null;
  agrees: boolean;
}

export interface IctTradeResult {
  success?: boolean;
  blocked?: boolean;
  executionState?: string;
  reason?: string;
  tradeId?: string | null;
  fillPrice?: number | null;
  units?: number | null;
}

export interface IctAnalysis {
  pair: string;
  timestamp: string;
  signalId: string;
  generatedAtMs: number;
  ictBias: 'bullish' | 'bearish' | 'neutral';
  ictNarrative: string;
  setupType: string | null;
  signal: 'buy' | 'sell' | 'none';
  entry: number | null;
  stopLoss: number | null;
  target1: number | null;
  target2: number | null;
  rr: number | null;
  confidence: number;
  conceptsDetected: string[];
  rejectionReasons: string[];
  concepts: IctConcepts | null;
  timing: IctTiming;
  v3Comparison: IctV3Comparison | null;
  mode: string;
}

export interface IctScanResult {
  analyses: IctAnalysis[];
  meta: {
    ictEngineMode: string;
    executionEnabled: boolean;
    pairsAnalyzed: number;
    generatedAt: string;
    signals: number;
  };
}

/** Envelope returned by /api/ict/analyze (scannerProxy wraps under `ict`). */
export interface IctApiResponse {
  ok: boolean;
  error?: string;
  ict?: IctScanResult;
  activeBroker?: string;
  activeEnvironment?: string;
  isLiveTrading?: boolean;
}

/** Envelope returned by POST /api/ict/trade. */
export interface IctTradeApiResponse {
  ok: boolean;
  error?: string;
  ict?: IctTradeResult;
}
