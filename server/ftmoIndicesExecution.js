import crypto from 'crypto';
import { ftmoIndicesConfig, isFtmoIndicesExecutionEnabled } from './ftmoIndicesConfig.js';
import { analyzeFtmoIndexSetup, calculateFtmoIndexVolume } from './ftmoIndicesEngine.js';
import { createFtmoBridgeSignature, getFtmoAccountSummary, getFtmoPositions, placeFtmoOrder } from './ftmoClient.js';

const INDEX_GROUP = 'US_INDICES';

function clean(value) {
  return String(value ?? '').trim();
}

async function getFtmoSymbolSpec(client, symbol) {
  const normalizedSymbol = clean(symbol);
  if (!normalizedSymbol) throw new Error('FTMO symbol is required');
  if (!client?.credentials?.bridgeUrl || typeof client?.fetchImpl !== 'function') {
    throw new Error('Invalid FTMO MT5 bridge client');
  }

  const body = JSON.stringify({
    account: {
      login: client.credentials.accountLogin,
      server: client.credentials.server,
      terminalId: client.credentials.terminalId,
    },
    symbol: normalizedSymbol,
  });
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const signature = createFtmoBridgeSignature({
    timestamp,
    nonce,
    body,
    secret: client.credentials.bridgeSecret,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), client.config?.timeoutMs || 8_000);
  try {
    const response = await client.fetchImpl(`${client.credentials.bridgeUrl}/v1/symbols/spec`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signal-stack-key': client.credentials.bridgeApiKey,
        'x-signal-stack-timestamp': timestamp,
        'x-signal-stack-nonce': nonce,
        'x-signal-stack-signature': signature,
      },
      body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || payload?.message || `FTMO MT5 bridge returned HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function positionRiskPercent(position, equity) {
  const explicit = Number(position?.riskPercent ?? position?.risk_percent);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const riskAmount = Number(position?.riskAmount ?? position?.risk_amount);
  return Number.isFinite(riskAmount) && Number(equity) > 0 ? (riskAmount / Number(equity)) * 100 : 0;
}

export function evaluateIndicesPortfolioRisk({ account = {}, positions = [], config = ftmoIndicesConfig() } = {}) {
  const equity = Number(account.equity ?? account.balance);
  const balance = Number(account.balance ?? account.equity);
  if (!(equity > 0) || !(balance > 0)) return { ok: false, reason: 'FTMO_ACCOUNT_EQUITY_UNAVAILABLE' };
  const pnl = equity - balance;
  const dailyLossPercent = pnl < 0 ? Math.abs(pnl / balance) * 100 : 0;
  const indexPositions = positions.filter((position) => config.symbols.includes(String(position.symbol || '')));
  const groupRiskPercent = indexPositions.reduce((sum, position) => sum + positionRiskPercent(position, equity), 0);
  if (dailyLossPercent >= config.hardDailyStopPercent) return { ok: false, reason: 'FTMO_INDICES_HARD_DAILY_STOP', dailyLossPercent, groupRiskPercent };
  if (dailyLossPercent >= config.dailyStopPercent) return { ok: false, reason: 'FTMO_INDICES_DAILY_STOP', dailyLossPercent, groupRiskPercent };
  if (groupRiskPercent >= config.groupRiskPercent) return { ok: false, reason: 'FTMO_INDICES_GROUP_RISK_CAP', dailyLossPercent, groupRiskPercent };
  if (indexPositions.length >= 2) return { ok: false, reason: 'FTMO_INDICES_CORRELATED_POSITION_CAP', dailyLossPercent, groupRiskPercent };
  return { ok: true, dailyLossPercent, groupRiskPercent, openIndexPositions: indexPositions.length };
}

export async function executeFtmoIndexSetup({ client, setupInput, env = process.env } = {}) {
  const config = ftmoIndicesConfig(env);
  const setup = analyzeFtmoIndexSetup(setupInput, env);
  if (!setup.qualified) return { ok: false, blocked: true, reason: 'SETUP_NOT_QUALIFIED', setup };
  if (!isFtmoIndicesExecutionEnabled(env)) return { ok: false, blocked: true, reason: 'FTMO_INDICES_EXECUTION_DISABLED', setup };
  if (!client) throw new Error('FTMO client is required');

  const [accountResult, positionResult, specResult] = await Promise.all([
    getFtmoAccountSummary(client),
    getFtmoPositions(client),
    getFtmoSymbolSpec(client, setup.symbol),
  ]);
  const account = accountResult.account ?? accountResult;
  const positions = positionResult.positions ?? positionResult.items ?? [];
  const portfolio = evaluateIndicesPortfolioRisk({ account, positions, config });
  if (!portfolio.ok) return { ok: false, blocked: true, reason: portfolio.reason, setup, portfolio };

  const spec = specResult.spec ?? specResult.symbol ?? specResult;
  const requestedRisk = Math.min(setup.risk.requestedRiskPercent, config.groupRiskPercent - portfolio.groupRiskPercent);
  const volume = calculateFtmoIndexVolume({
    equity: account.equity ?? account.balance,
    riskPercent: requestedRisk,
    entry: setup.levels.entry,
    stopLoss: setup.levels.stopLoss,
    tickSize: spec.tickSize ?? spec.tick_size,
    tickValue: spec.tickValue ?? spec.tick_value,
    volumeMin: spec.volumeMin ?? spec.volume_min,
    volumeMax: spec.volumeMax ?? spec.volume_max,
    volumeStep: spec.volumeStep ?? spec.volume_step,
  });

  const order = {
    symbol: setup.symbol,
    side: setup.direction === 'bullish' ? 'buy' : 'sell',
    volume,
    stopLoss: setup.levels.stopLoss,
    takeProfit: setup.levels.target,
    comment: `signal-stack:${config.engineId}:${INDEX_GROUP}`,
    metadata: {
      engine: config.engineId,
      exposureGroup: INDEX_GROUP,
      confidence: setup.confidence,
      riskPercent: requestedRisk,
      rr: setup.levels.rr,
    },
  };
  const result = await placeFtmoOrder(client, order);
  return { ok: result?.ok !== false, setup, portfolio, order, broker: result };
}
