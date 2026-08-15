const truthy = (value) => ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const FTMO_INDEX_SYMBOLS = Object.freeze({
  US30: process.env.FTMO_INDICES_US30_SYMBOL || 'US30.cash',
  US100: process.env.FTMO_INDICES_US100_SYMBOL || 'US100.cash',
  US500: process.env.FTMO_INDICES_US500_SYMBOL || 'US500.cash',
});

export function configuredFtmoIndexSymbols(env = process.env) {
  const fallback = Object.values(FTMO_INDEX_SYMBOLS);
  const configured = String(env.FTMO_INDICES_SYMBOLS || fallback.join(','))
    .split(',')
    .map((symbol) => symbol.trim())
    .filter(Boolean);
  return [...new Set(configured)].slice(0, 3);
}

export function ftmoIndicesConfig(env = process.env) {
  const mode = String(env.FTMO_INDICES_ENGINE_MODE || 'shadow').trim().toLowerCase();
  return {
    engineId: 'ftmo_indices',
    mode,
    enabled: ['shadow', 'paper', 'active', 'live'].includes(mode),
    autoTradeEnabled: truthy(env.FTMO_INDICES_AUTO_TRADE_ENABLED),
    liveExecutionEnabled: truthy(env.FTMO_INDICES_LIVE_EXECUTION_ENABLED),
    accountModel: String(env.FTMO_ACCOUNT_MODEL || 'two_step').trim().toLowerCase(),
    symbols: configuredFtmoIndexSymbols(env),
    primarySymbol: String(env.FTMO_INDICES_PRIMARY_SYMBOL || FTMO_INDEX_SYMBOLS.US500).trim(),
    minConfidence: 75,
    minRR: Math.max(1.5, number(env.FTMO_INDICES_MIN_RR, 1.5)),
    riskPercent: Math.min(0.75, Math.max(0.1, number(env.FTMO_INDICES_RISK_PERCENT, 0.5))),
    aPlusRiskPercent: Math.min(0.75, Math.max(0.1, number(env.FTMO_INDICES_A_PLUS_RISK_PERCENT, 0.75))),
    groupRiskPercent: Math.min(1, Math.max(0.1, number(env.FTMO_INDICES_GROUP_RISK_PERCENT, 0.75))),
    dailyStopPercent: Math.min(2, Math.max(0.5, number(env.FTMO_INDICES_DAILY_STOP_PERCENT, 1.5))),
    hardDailyStopPercent: Math.min(2.5, Math.max(1, number(env.FTMO_INDICES_HARD_DAILY_STOP_PERCENT, 2))),
    maxTradesPerDay: Math.min(3, Math.max(1, Math.trunc(number(env.FTMO_INDICES_MAX_TRADES_PER_DAY, 3)))),
    maxConsecutiveLosses: Math.min(3, Math.max(1, Math.trunc(number(env.FTMO_INDICES_MAX_CONSECUTIVE_LOSSES, 2)))),
    openingRangeMinutes: Math.min(30, Math.max(5, Math.trunc(number(env.FTMO_INDICES_OPENING_RANGE_MINUTES, 15)))),
    signalTtlSec: Math.min(900, Math.max(60, number(env.FTMO_INDICES_SIGNAL_TTL_SEC, 300))),
    requireSweep: env.FTMO_INDICES_REQUIRE_SWEEP == null ? true : truthy(env.FTMO_INDICES_REQUIRE_SWEEP),
    requireDisplacement: env.FTMO_INDICES_REQUIRE_DISPLACEMENT == null ? true : truthy(env.FTMO_INDICES_REQUIRE_DISPLACEMENT),
    requireStructureShift: env.FTMO_INDICES_REQUIRE_STRUCTURE_SHIFT == null ? true : truthy(env.FTMO_INDICES_REQUIRE_STRUCTURE_SHIFT),
    requirePdArray: env.FTMO_INDICES_REQUIRE_PD_ARRAY == null ? true : truthy(env.FTMO_INDICES_REQUIRE_PD_ARRAY),
    allowMarketFallback: truthy(env.FTMO_INDICES_ALLOW_MARKET_FALLBACK),
  };
}

export function isFtmoIndicesExecutionEnabled(env = process.env) {
  const config = ftmoIndicesConfig(env);
  return ['active', 'live'].includes(config.mode)
    && config.autoTradeEnabled
    && config.liveExecutionEnabled;
}

export function instrumentRiskMultiplier(symbol) {
  const value = String(symbol || '').toUpperCase();
  if (value.includes('US100') || value.includes('USTEC') || value.includes('NAS')) return 0.75;
  if (value.includes('US30') || value.includes('DJ')) return 0.75;
  return 1;
}
