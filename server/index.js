import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Alpaca from '@alpacahq/alpaca-trade-api';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import alpacaBars from './alpacaBars.js';
import alpacaAssets from './alpacaAssets.js';

// ─── OANDA imports ─────────────────────────────────────────────────────────
import { runDiagnostics } from './oandaDiagnostics.js';
import { getAccountSummary, getInstruments, getPricing, getCandles } from './oandaMarketData.js';
import { V3_MODE } from './v3Engine.js';
import { analyzeICTPairs, ICT_MODE } from './ictEngine.js';
import { executeIctTrade } from './ictExecution.js';
import { buildFtmoClient, validateFtmoCredentials } from './ftmoClient.js';
import { runAutoAiForUser } from './ictAutoTrade.js';
import { startAutoAiScheduler } from './ictAutoScheduler.js';
import { reassessIctTrade } from './ictLifecycleEngine.js';
import { runAutoForUser } from './autoAiRouter.js';
import { scanPprMarket } from './pprEngine.js';
import { executePprTrade } from './pprExecution.js';
import { runV3DashboardScan } from './v3DashboardScan.js';
import { isExecutableEnvironment } from './autoAiGating.js';
import { getRiskStatus, resetDailyRisk } from './riskManager.js';
import {
  executeTrade,
  closePosition,
  closeBrokerTrade,
  getTradeState,
  resetDailyCounters,
  reconcileAllLocks,
} from './oandaTrade.js';
import { updateBrokerTradeProtection } from './oandaTradeProtection.js';
import { getLatestSignals } from './oandaSignalStore.js';
import { getTradeHistory, getPerformanceStats } from './oandaTradeHistory.js';
import { startExitManager, getExitManagerStatus } from './oandaExitManager.js';
import { analyzeActiveTrades } from './oandaActiveTradeMonitor.js';
import { reassessActiveTrades, startReassessmentScheduler } from './oandaActiveTradeReassessor.js';
import { createOandaClient } from './oandaClient.js';
import { getCalibrationSnapshot } from './oandaCalibration.js';
import { runUserScoped } from './requestContext.js';
import { executeRecentQualifiedV3Signal } from './v3ManualExecution.js';
import { PROVIDERS, assertExecutionProvider } from './providerRouting.js';
import {
  ninjaTraderConnectivityCheck, buildNinjaTraderClient, getNinjaTraderAccounts,
  getNinjaTraderPositions, placeNinjaTraderOrder, closeNinjaTraderPosition,
  ninjaTraderFuturesEnabled, getNinjaTraderDiagnostics,
} from './ninjatraderClient.js';
import {
  topstepConnectivityCheck, buildTopstepClient, getTopstepAccounts,
  getTopstepPositions, placeTopstepOrder, closeTopstepPosition,
  topstepEnabled, evaluateTopstepExecution, getTopstepDiagnostics,
} from './topstepClient.js';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  override: true,
});

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

app.use('/api/alpaca', alpacaBars);
app.use('/api/alpaca', alpacaAssets);

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';
const SHADOW_MODE = (process.env.SHADOW_MODE ?? 'false') === 'true';

const users = [
  {
    id: 1,
    username: process.env.ADMIN_USERNAME || 'admin',
    password: process.env.ADMIN_PASSWORD_HASH || '$2a$10$invalidhashplaceholderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    alpacaApiKey: null,
    alpacaSecretKey: null,
    alpacaPaperTrading: false,
  },
];

const alpacaClients = new Map();
const alpacaProfiles = new Map();
const orderTimestamps = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY ALPACA OPTIONS RISK CONFIG — scoped to the /api/alpaca/live/* options
// trading subsystem only. This is NOT the Signal Stack forex risk layer: the
// per-trade cap, daily drawdown lock, and auto-execution confidence floor for
// OANDA execution live in server/riskManager.js. Do not conflate the two.
// ─────────────────────────────────────────────────────────────────────────────
const ALPACA_OPTIONS_RISK_CONFIG = {
  MAX_TRADES_PER_DAY: 3,
  MAX_CONTRACTS: 1,
  MAX_OPEN_POSITIONS: 3,
  MAX_RISK_PER_TRADE_PCT: 0.01,
  MAX_DAILY_LOSS_PCT: 0.02,
  DAILY_TARGET_PCT: 0.02,
  MAX_CONSECUTIVE_LOSSES: 2,
  ORDER_CANCEL_TIMEOUT_MS: 5 * 60 * 1000,
};

const alpacaOptionsRiskState = {
  live: {
    tradesToday: 0,
    consecutiveLosses: 0,
    dailyPnl: 0,
    tradingDisabled: false,
    disableReason: null,
    lastReset: null,
  },
};

function getTodayET() {
  return new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });
}

function resetDailyStateIfNeeded() {
  const today = getTodayET();
  const state = alpacaOptionsRiskState.live;

  if (state.lastReset !== today) {
    state.tradesToday = 0;
    state.consecutiveLosses = 0;
    state.dailyPnl = 0;
    state.tradingDisabled = false;
    state.disableReason = null;
    state.lastReset = today;
  }
}

function getAlpacaKeys() {
  const key = process.env.ALPACA_LIVE_API_KEY;
  const secret = process.env.ALPACA_LIVE_API_SECRET;

  if (!key || !secret) {
    throw new Error('Alpaca LIVE credentials not configured in environment variables');
  }

  return { key, secret };
}

function alpacaHeaders() {
  const { key, secret } = getAlpacaKeys();

  return {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
  };
}

function getLiveAlpacaClient() {
  const { key, secret } = getAlpacaKeys();

  return new Alpaca({
    key,
    secret,
    paper: false,
    baseUrl: 'https://api.alpaca.markets',
    usePolygon: false,
  });
}

function splitSymbols(value, max = 100) {
  return String(value || '')
    .split(',')
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, max);
}

function chunk(items, size = 100) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function alpacaAuthError(res) {
  return res.status(401).json({
    error: 'Alpaca authorization failed — check ALPACA_LIVE_API_KEY, ALPACA_LIVE_API_SECRET, and live endpoint access.',
  });
}

async function alpacaDataGet(pathname, params) {
  const url = new URL(`https://data.alpaca.markets${pathname}`);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, { headers: alpacaHeaders() });
  const text = await response.text();

  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }

  if (response.status === 401) {
    const err = new Error('ALPACA_AUTH');
    err.status = 401;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(body?.message || body?.error || `Alpaca data API failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return body;
}

async function alpacaTradingGet(pathname, params) {
  const url = new URL(`https://api.alpaca.markets${pathname}`);

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });

  const response = await fetch(url, { headers: alpacaHeaders() });
  const text = await response.text();

  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }

  if (response.status === 401) {
    const err = new Error('ALPACA_AUTH');
    err.status = 401;
    throw err;
  }

  if (!response.ok) {
    const err = new Error(body?.message || body?.error || `Alpaca trading API failed: ${response.status}`);
    err.status = response.status;
    throw err;
  }

  return body;
}

function normalizeStockSnapshot(symbol, snapshot) {
  const trade = snapshot?.latestTrade || snapshot?.latest_trade || {};
  const quote = snapshot?.latestQuote || snapshot?.latest_quote || {};
  const minute = snapshot?.minuteBar || snapshot?.minute_bar || {};
  const daily = snapshot?.dailyBar || snapshot?.daily_bar || {};
  const previous = snapshot?.previousDailyBar || snapshot?.previous_daily_bar || {};

  const latestPrice = num(trade.p ?? trade.price ?? minute.c ?? daily.c);
  const bid = num(quote.bp ?? quote.bidPrice ?? quote.bid_price);
  const ask = num(quote.ap ?? quote.askPrice ?? quote.ask_price);
  const previousClose = num(previous.c ?? previous.close);

  const percentChange = latestPrice !== null && previousClose
    ? ((latestPrice - previousClose) / previousClose) * 100
    : null;

  return {
    symbol,
    latestPrice,
    bid,
    ask,
    volume: num(minute.v ?? minute.volume),
    dailyVolume: num(daily.v ?? daily.volume),
    minuteBarClose: num(minute.c ?? minute.close),
    dailyOpen: num(daily.o ?? daily.open),
    dailyHigh: num(daily.h ?? daily.high),
    dailyLow: num(daily.l ?? daily.low),
    previousClose,
    percentChange,
    spread: bid !== null && ask !== null ? ask - bid : null,
    timestamp: trade.t ?? quote.t ?? minute.t ?? daily.t ?? null,
  };
}

function normalizeLatestBar(symbol, bar) {
  return {
    symbol,
    open: num(bar?.o ?? bar?.open),
    high: num(bar?.h ?? bar?.high),
    low: num(bar?.l ?? bar?.low),
    close: num(bar?.c ?? bar?.close),
    volume: num(bar?.v ?? bar?.volume),
    timestamp: bar?.t ?? bar?.timestamp ?? null,
    source: 'alpaca',
  };
}

function normalizeOptionContract(contract) {
  return {
    underlying: contract.underlying_symbol || contract.underlying || contract.root_symbol || '',
    optionSymbol: contract.symbol,
    expirationDate: contract.expiration_date,
    strikePrice: num(contract.strike_price),
    type: String(contract.type || '').toLowerCase(),
    status: contract.status,
    tradable: contract.tradable === true,
    rootSymbol: contract.root_symbol || contract.underlying_symbol || '',
  };
}

function normalizeOptionSnapshot(optionSymbol, snapshot) {
  const trade = snapshot?.latestTrade || snapshot?.latest_trade || {};
  const quote = snapshot?.latestQuote || snapshot?.latest_quote || {};
  const greeks = snapshot?.greeks || {};

  const bid = num(quote.bp ?? quote.bidPrice ?? quote.bid_price);
  const ask = num(quote.ap ?? quote.askPrice ?? quote.ask_price);

  return {
    optionSymbol,
    bid,
    ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
    lastPrice: num(trade.p ?? trade.price),
    volume: num(snapshot?.volume),
    openInterest: num(snapshot?.openInterest ?? snapshot?.open_interest),
    impliedVolatility: num(snapshot?.impliedVolatility ?? snapshot?.implied_volatility),
    delta: num(greeks.delta),
    gamma: num(greeks.gamma),
    theta: num(greeks.theta),
    vega: num(greeks.vega),
    timestamp: trade.t ?? quote.t ?? null,
  };
}

function formatAccount(account) {
  return {
    accountNumber: account.account_number,
    buyingPower: parseFloat(account.buying_power || 0),
    cash: parseFloat(account.cash || 0),
    portfolioValue: parseFloat(account.portfolio_value || 0),
    equity: parseFloat(account.equity || account.portfolio_value || 0),
    daytradeCount: account.daytrade_count,
    status: account.status,
    tradingBlocked: account.trading_blocked,
    transfersBlocked: account.transfers_blocked,
    accountBlocked: account.account_blocked,
    patternDayTrader: account.pattern_day_trader,
    optionsLevel: account.options_level ?? null,
  };
}

function maskAccountNumber(acctNum) {
  if (!acctNum || acctNum.length < 4) return '****';
  return '****' + acctNum.slice(-4);
}

function isWithinTradingWindow() {
  const etStr = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const et = new Date(etStr);

  const day = et.getDay();
  if (day === 0 || day === 6) return false;

  const total = et.getHours() * 60 + et.getMinutes();
  return total >= 9 * 60 + 35 && total <= 15 * 60 + 55;
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }

    req.user = user;
    next();
  });
}

function getAnthropicClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

app.get('/test123', (_req, res) => {
  res.json({ working: true });
});


// Manually reconcile stale in-memory trade locks against live OANDA positions
app.post('/api/admin/reconcile-trade-locks', async (req, res) => {
  try {
    const summary = await reconcileAllLocks('manual');
    res.status(409).json({
      ok: false,
      error: 'Manual reconcile requires a request-scoped OANDA client in multi-tenant mode.',
      summary,
    });
  } catch (err) {
    console.error('[RECONCILE TRADE LOCKS ERROR]', err);
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'OK',
    mode: 'live',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/alpaca/route-test', (_req, res) => {
  res.json({
    ok: true,
    route: '/api/alpaca',
    mode: 'live',
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/alpaca/diagnostics', async (_req, res) => {
  const key = process.env.ALPACA_LIVE_API_KEY;
  const secret = process.env.ALPACA_LIVE_API_SECRET;

  if (!key || !secret) {
    return res.status(503).json({
      ok: false,
      mode: 'live',
      error: 'Missing ALPACA_LIVE_API_KEY or ALPACA_LIVE_API_SECRET',
      timestamp: new Date().toISOString(),
    });
  }

  const headers = {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
  };

  const tests = [
    {
      name: 'Live Trading Account',
      url: 'https://api.alpaca.markets/v2/account',
    },
    {
      name: 'Live Trading Assets',
      url: 'https://api.alpaca.markets/v2/assets?status=active&asset_class=us_equity',
    },
    {
      name: 'Market Data Latest Bar',
      url: 'https://data.alpaca.markets/v2/stocks/bars/latest?symbols=AAPL&feed=iex',
    },
    {
      name: 'Market Data Snapshots',
      url: 'https://data.alpaca.markets/v2/stocks/snapshots?symbols=AAPL&feed=iex',
    },
    {
      name: 'Market Data Quotes',
      url: 'https://data.alpaca.markets/v2/stocks/quotes/latest?symbols=AAPL&feed=iex',
    },
  ];

  const results = [];

  for (const test of tests) {
    try {
      const response = await fetch(test.url, { headers });
      const body = await response.json().catch(() => null);

      results.push({
        name: test.name,
        status: response.status,
        ok: response.ok,
        baseUrl: test.url.replace(/\?.*$/, ''),
        error: response.ok ? null : body?.message || body?.error || body,
      });
    } catch (err) {
      results.push({
        name: test.name,
        ok: false,
        status: null,
        error: err instanceof Error ? err.message : 'Request failed',
      });
    }
  }

  res.json({
    ok: results.every(r => r.ok),
    mode: 'live',
    results,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = users.find(u => u.username === username);

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        hasAlpacaCredentials: true,
      },
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/alpaca/credentials', authenticateToken, async (req, res) => {
  try {
    const { apiKey, secretKey } = req.body;

    if (!apiKey || !secretKey) {
      return res.status(400).json({ error: 'API key and secret key required' });
    }

    const testAlpaca = new Alpaca({
      key: apiKey,
      secret: secretKey,
      paper: false,
      baseUrl: 'https://api.alpaca.markets',
      usePolygon: false,
    });

    await testAlpaca.getAccount();

    const user = users.find(u => u.id === req.user.userId);

    if (user) {
      user.alpacaApiKey = apiKey;
      user.alpacaSecretKey = secretKey;
      user.alpacaPaperTrading = false;
      alpacaClients.set(req.user.userId, testAlpaca);
    }

    res.json({
      success: true,
      message: 'Live Alpaca credentials verified and saved for this server session',
    });
  } catch (error) {
    console.error('Alpaca connection error:', error.message);
    res.status(400).json({ error: 'Invalid live Alpaca credentials or connection failed' });
  }
});

app.get('/api/alpaca/account', authenticateToken, async (req, res) => {
  try {
    const alpaca = alpacaClients.get(req.user.userId) || getLiveAlpacaClient();
    const account = await alpaca.getAccount();

    res.json(formatAccount(account));
  } catch (error) {
    console.error('Account fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch account information' });
  }
});

app.get('/api/alpaca/positions', authenticateToken, async (req, res) => {
  try {
    const alpaca = alpacaClients.get(req.user.userId) || getLiveAlpacaClient();
    const positions = await alpaca.getPositions();

    res.json(positions.map(pos => ({
      symbol: pos.symbol,
      qty: parseFloat(pos.qty),
      marketValue: parseFloat(pos.market_value || 0),
      costBasis: parseFloat(pos.cost_basis || 0),
      unrealizedPL: parseFloat(pos.unrealized_pl || 0),
      unrealizedPLPercent: parseFloat(pos.unrealized_plpc || 0),
      side: pos.side,
      avgEntryPrice: parseFloat(pos.avg_entry_price || 0),
    })));
  } catch (error) {
    console.error('Positions fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch positions' });
  }
});

app.get('/api/alpaca/orders', authenticateToken, async (req, res) => {
  try {
    const alpaca = alpacaClients.get(req.user.userId) || getLiveAlpacaClient();

    const orders = await alpaca.getOrders({
      status: 'all',
      limit: 50,
      nested: true,
    });

    res.json(orders.map(order => ({
      id: order.id,
      symbol: order.symbol,
      qty: parseFloat(order.qty || 0),
      side: order.side,
      orderType: order.order_type,
      timeInForce: order.time_in_force,
      status: order.status,
      filledQty: parseFloat(order.filled_qty || 0),
      filledAvgPrice: parseFloat(order.filled_avg_price || 0),
      submittedAt: order.submitted_at,
      filledAt: order.filled_at,
    })));
  } catch (error) {
    console.error('Orders fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

app.post('/api/alpaca/orders', authenticateToken, async (req, res) => {
  try {
    const alpaca = alpacaClients.get(req.user.userId) || getLiveAlpacaClient();

    const {
      symbol,
      qty,
      side,
      type = 'market',
      timeInForce = 'day',
      limitPrice,
      stopPrice,
    } = req.body;

    if (!symbol || !qty || !side) {
      return res.status(400).json({ error: 'Symbol, quantity, and side are required' });
    }

    const orderData = {
      symbol: symbol.toUpperCase(),
      qty: Math.abs(qty),
      side: side.toLowerCase(),
      type: type.toLowerCase(),
      time_in_force: timeInForce.toLowerCase(),
    };

    if (type.toLowerCase() === 'limit' && limitPrice) {
      orderData.limit_price = limitPrice;
    }

    if (type.toLowerCase() === 'stop' && stopPrice) {
      orderData.stop_price = stopPrice;
    }

    const order = await alpaca.createOrder(orderData);

    res.json({
      id: order.id,
      symbol: order.symbol,
      qty: parseFloat(order.qty || 0),
      side: order.side,
      type: order.order_type,
      status: order.status,
      submittedAt: order.submitted_at,
    });
  } catch (error) {
    console.error('Order placement error:', error.message);
    res.status(500).json({ error: 'Failed to place order: ' + error.message });
  }
});

app.get('/api/alpaca/quotes/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const alpaca = getLiveAlpacaClient();
    const quote = await alpaca.getLatestTrade(symbol.toUpperCase());

    const price = Number(quote.Price ?? quote.price ?? quote.p ?? 0);
    const timestamp = quote.Timestamp ?? quote.timestamp ?? quote.t ?? new Date().toISOString();

    res.json({
      symbol: symbol.toUpperCase(),
      price,
      timestamp,
      source: 'alpaca',
      environment: 'live',
    });
  } catch (error) {
    console.error('Quote fetch error:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote' });
  }
});

app.get('/api/alpaca/assets/test', (_req, res) => {
  res.json({
    ok: true,
    route: '/api/alpaca/assets',
    mode: 'live',
    credentialsLoaded: Boolean(process.env.ALPACA_LIVE_API_KEY && process.env.ALPACA_LIVE_API_SECRET),
  });
});

app.get('/api/alpaca/assets', async (_req, res) => {
  try {
    const client = getLiveAlpacaClient();

    const assets = await client.getAssets({
      status: 'active',
      asset_class: 'us_equity',
    });

    const symbols = assets
      .filter(asset =>
        asset.status === 'active' &&
        asset.tradable === true &&
        asset.asset_class === 'us_equity' &&
        typeof asset.symbol === 'string' &&
        asset.symbol.length > 0 &&
        !asset.symbol.includes('.')
      )
      .map(asset => asset.symbol)
      .sort();

    res.json({
      symbols,
      total: symbols.length,
      source: 'alpaca',
      environment: 'live',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[alpaca/assets]:', err.message);
    res.status(err.message.includes('not configured') ? 503 : 502).json({ error: err.message });
  }
});

app.get('/api/alpaca/market/snapshots', async (req, res) => {
  try {
    const feed = String(req.query.feed || process.env.ALPACA_STOCK_FEED || 'iex');
    const symbols = splitSymbols(req.query.symbols, 500);

    if (!symbols.length) {
      return res.status(400).json({ error: 'symbols query parameter is required' });
    }

    const snapshots = [];

    for (const group of chunk(symbols, 100)) {
      const body = await alpacaDataGet('/v2/stocks/snapshots', {
        symbols: group.join(','),
        feed,
      });

      const rawSnapshots = body.snapshots || body;

      group.forEach(symbol => {
        if (rawSnapshots?.[symbol]) {
          snapshots.push(normalizeStockSnapshot(symbol, rawSnapshots[symbol]));
        }
      });
    }

    res.json({
      source: 'alpaca',
      environment: 'live',
      feed,
      snapshots,
      total: snapshots.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.status === 401) return alpacaAuthError(res);

    console.error('[alpaca/market/snapshots]:', err.message);
    res.status(err.message.includes('not configured') ? 503 : 502).json({ error: err.message });
  }
});

app.get('/api/alpaca/market/bars/latest', async (req, res) => {
  try {
    const feed = String(req.query.feed || process.env.ALPACA_STOCK_FEED || 'iex');
    const symbols = splitSymbols(req.query.symbols, 500);

    if (!symbols.length) {
      return res.status(400).json({ error: 'symbols query parameter is required' });
    }

    const bars = [];

    for (const group of chunk(symbols, 100)) {
      const body = await alpacaDataGet('/v2/stocks/bars/latest', {
        symbols: group.join(','),
        feed,
      });

      const rawBars = body.bars || body;

      group.forEach(symbol => {
        if (rawBars?.[symbol]) {
          bars.push(normalizeLatestBar(symbol, rawBars[symbol]));
        }
      });
    }

    res.json({
      source: 'alpaca',
      environment: 'live',
      feed,
      bars,
      total: bars.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.status === 401) return alpacaAuthError(res);

    console.error('[alpaca/market/bars/latest]:', err.message);
    res.status(err.message.includes('not configured') ? 503 : 502).json({ error: err.message });
  }
});

app.get('/api/alpaca/options/contracts', async (req, res) => {
  try {
    const underlying = String(req.query.underlying || '').trim().toUpperCase();
    const type = String(req.query.type || 'call').toLowerCase();
    const underlyingPrice = num(req.query.underlyingPrice || req.query.price);

    if (!underlying) {
      return res.status(400).json({ error: 'underlying query parameter is required' });
    }

    const today = new Date();
    const minExpiration = new Date(today);
    minExpiration.setDate(today.getDate() + 7);

    const maxExpiration = new Date(today);
    maxExpiration.setDate(today.getDate() + 45);

    const expirationDateGte = minExpiration.toISOString().slice(0, 10);
    const expirationDateLte = maxExpiration.toISOString().slice(0, 10);

    const contracts = [];
    let pageToken = undefined;

    do {
      const body = await alpacaTradingGet('/v2/options/contracts', {
        underlying_symbols: underlying,
        status: 'active',
        type,
        expiration_date_gte: expirationDateGte,
        expiration_date_lte: expirationDateLte,
        limit: 1000,
        page_token: pageToken,
      });

      contracts.push(...(body.option_contracts || body.contracts || []));
      pageToken = body.next_page_token;
    } while (pageToken && contracts.length < 1500);

    const normalized = contracts
      .map(normalizeOptionContract)
      .filter(contract =>
        contract.optionSymbol &&
        contract.tradable === true &&
        contract.status === 'active' &&
        (!type || contract.type === type) &&
        (!underlyingPrice || !contract.strikePrice || Math.abs(contract.strikePrice - underlyingPrice) / underlyingPrice <= 0.15)
      )
      .sort((a, b) => {
        const expirySort = String(a.expirationDate).localeCompare(String(b.expirationDate));

        if (expirySort !== 0) return expirySort;
        if (!underlyingPrice) return (a.strikePrice || 0) - (b.strikePrice || 0);

        return Math.abs((a.strikePrice || 0) - underlyingPrice) -
          Math.abs((b.strikePrice || 0) - underlyingPrice);
      })
      .slice(0, 100);

    res.json({
      source: 'alpaca',
      environment: 'live',
      underlying,
      type,
      expirationDateGte,
      expirationDateLte,
      contracts: normalized,
      total: normalized.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.status === 401) return alpacaAuthError(res);

    console.error('[alpaca/options/contracts]:', err.message);
    res.status(err.message.includes('not configured') ? 503 : 502).json({ error: err.message });
  }
});

app.get('/api/alpaca/options/snapshots', async (req, res) => {
  try {
    const feed = String(req.query.feed || process.env.ALPACA_OPTIONS_FEED || 'indicative');
    const symbols = splitSymbols(req.query.symbols, 500);

    if (!symbols.length) {
      return res.status(400).json({ error: 'symbols query parameter is required' });
    }

    const snapshots = [];

    for (const group of chunk(symbols, 100)) {
      const body = await alpacaDataGet('/v1beta1/options/snapshots', {
        symbols: group.join(','),
        feed,
      });

      const rawSnapshots = body.snapshots || body;

      group.forEach(symbol => {
        if (rawSnapshots?.[symbol]) {
          snapshots.push(normalizeOptionSnapshot(symbol, rawSnapshots[symbol]));
        }
      });
    }

    res.json({
      source: 'alpaca',
      environment: 'live',
      feed,
      snapshots,
      total: snapshots.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    if (err.status === 401) return alpacaAuthError(res);

    console.error('[alpaca/options/snapshots]:', err.message);
    res.status(err.message.includes('not configured') ? 503 : 502).json({ error: err.message });
  }
});

app.post('/api/alpaca/validate', async (req, res) => {
  try {
    const { apiKey, apiSecret, environment } = req.body;

    if (!apiKey || !apiSecret) {
      return res.status(400).json({ error: 'apiKey and apiSecret are required' });
    }

    if (environment && environment !== 'live') {
      return res.status(400).json({ error: 'This server is configured for live Alpaca trading only' });
    }

    const alpacaClient = new Alpaca({
      key: apiKey,
      secret: apiSecret,
      paper: false,
      baseUrl: 'https://api.alpaca.markets',
      usePolygon: false,
    });

    const account = await alpacaClient.getAccount();

    res.json({
      success: true,
      accountStatus: account.status,
      accountNumberMasked: maskAccountNumber(account.account_number || ''),
      environment: 'live',
    });
  } catch (err) {
    console.error('[alpaca/validate]:', err.message);
    res.status(401).json({ error: 'Invalid live credentials or Alpaca API unreachable' });
  }
});

app.post('/api/alpaca/profile', authenticateToken, (req, res) => {
  try {
    const {
      accountType,
      tradingEnabled,
      autoTradeEnabled,
      accountStatus,
      accountNumberMasked,
    } = req.body;

    const profile = {
      id: crypto.randomUUID(),
      environment: 'live',
      accountType: accountType || 'individual',
      tradingEnabled: tradingEnabled === true,
      autoTradeEnabled: autoTradeEnabled === true,
      isConnected: true,
      lastValidatedAt: new Date().toISOString(),
      accountStatus: accountStatus || undefined,
      accountNumberMasked: accountNumberMasked || undefined,
    };

    alpacaProfiles.set(req.user.userId, profile);
    res.json(profile);
  } catch (err) {
    console.error('[alpaca/profile POST]:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/alpaca/profile', authenticateToken, (req, res) => {
  const profile = alpacaProfiles.get(req.user.userId) || null;
  res.json(profile);
});

app.delete('/api/alpaca/profile', authenticateToken, (req, res) => {
  alpacaProfiles.delete(req.user.userId);
  res.json({ success: true });
});

app.get('/api/alpaca/live/account', async (_req, res) => {
  try {
    const client = getLiveAlpacaClient();
    const account = await client.getAccount();

    res.json(formatAccount(account));
  } catch (err) {
    console.error('[live/account]:', err.message);
    res.status(err.message.includes('not configured') ? 503 : 502).json({ error: err.message });
  }
});

app.get('/api/alpaca/live/positions', async (_req, res) => {
  try {
    const client = getLiveAlpacaClient();
    const positions = await client.getPositions();

    res.json(positions.map(p => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty || 0),
      marketValue: parseFloat(p.market_value || 0),
      unrealizedPL: parseFloat(p.unrealized_pl || 0),
      unrealizedPLPercent: parseFloat(p.unrealized_plpc || 0),
      side: p.side,
    })));
  } catch (err) {
    console.error('[live/positions]:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/alpaca/live/orders', async (_req, res) => {
  try {
    const client = getLiveAlpacaClient();
    const orders = await client.getOrders({ status: 'open', limit: 50 });

    res.json(orders.map(o => ({
      id: o.id,
      symbol: o.symbol,
      qty: parseFloat(o.qty || 0),
      side: o.side,
      type: o.order_type,
      status: o.status,
      limitPrice: o.limit_price ? parseFloat(o.limit_price) : undefined,
      submittedAt: o.submitted_at,
      filledAt: o.filled_at,
    })));
  } catch (err) {
    console.error('[live/orders]:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/alpaca/live/risk-state', (_req, res) => {
  resetDailyStateIfNeeded();

  const s = alpacaOptionsRiskState.live;

  res.json({
    tradesToday: s.tradesToday,
    consecutiveLosses: s.consecutiveLosses,
    dailyPnl: s.dailyPnl,
    tradingDisabled: s.tradingDisabled,
    disableReason: s.disableReason,
    dailyTargetReached: false,
    shadowMode: SHADOW_MODE,
    environment: 'live',
  });
});

app.post('/api/alpaca/live/trade', async (req, res) => {
  try {
    const { signal, qty = 1, shadowMode: clientShadow = false } = req.body;

    if (!signal || !signal.optionSymbol || !signal.limitPrice) {
      return res.status(400).json({ error: 'signal.optionSymbol and signal.limitPrice are required' });
    }

    if (signal.source !== 'alpaca' || signal.isLive !== true) {
      return res.json({ action: 'block', reason: 'Signal must be a live Alpaca AI signal' });
    }

    if (signal.aiDecision !== 'APPROVE' && signal.advisoryDecision !== 'APPROVE') {
      return res.json({ action: 'block', reason: 'AI approval required before trade submission' });
    }

    resetDailyStateIfNeeded();

    const state = alpacaOptionsRiskState.live;

    const isShadow = SHADOW_MODE || clientShadow;

    console.log('[LIVE TRADE CHECK]', {
      serverShadow: process.env.SHADOW_MODE,
      clientShadow,
      finalShadow: isShadow,
    });

    if (state.tradingDisabled) {
      return res.json({ action: 'block', reason: state.disableReason || 'Trading disabled' });
    }

    if (state.tradesToday >= ALPACA_OPTIONS_RISK_CONFIG.MAX_TRADES_PER_DAY) {
      return res.json({
        action: 'block',
        reason: `Max trades per day reached (${ALPACA_OPTIONS_RISK_CONFIG.MAX_TRADES_PER_DAY})`,
      });
    }

    if (state.consecutiveLosses >= ALPACA_OPTIONS_RISK_CONFIG.MAX_CONSECUTIVE_LOSSES) {
      state.tradingDisabled = true;
      state.disableReason = `${ALPACA_OPTIONS_RISK_CONFIG.MAX_CONSECUTIVE_LOSSES} consecutive losses`;
      return res.json({ action: 'block', reason: state.disableReason });
    }

    if (!isWithinTradingWindow()) {
      return res.json({ action: 'block', reason: 'Outside trading window (9:35–15:55 ET Mon–Fri)' });
    }

    if (signal.totalScore < 14) {
      return res.json({ action: 'block', reason: `Score too low (${signal.totalScore}/20)` });
    }

    if (signal.confidence < 65) {
      return res.json({ action: 'block', reason: `Confidence too low (${signal.confidence}%)` });
    }

    if (signal.riskReward < 1.6) {
      return res.json({ action: 'block', reason: `R/R too low (${signal.riskReward})` });
    }

    if (!['A', 'A+', 'B'].includes(signal.grade)) {
      return res.json({ action: 'block', reason: `Grade not A/A+/B (${signal.grade})` });
    }

    console.log(`[TRADE EVAL] ${signal.optionSymbol} score=${signal.totalScore} conf=${signal.confidence} rr=${signal.riskReward} grade=${signal.grade}`);

    if (signal.marketAlignment === 'BEARISH') {
      return res.json({ action: 'block', reason: 'Market alignment bearish' });
    }

    if (isShadow) {
      console.log(`[SHADOW] Would submit LIVE order: ${signal.optionSymbol} x${qty} @ $${signal.limitPrice}`);

      return res.json({
        action: 'shadow',
        reason: 'Shadow mode active — no live order submitted',
        environment: 'live',
      });
    }

    const accountResp = await fetch('https://api.alpaca.markets/v2/account', {
      headers: alpacaHeaders(),
    });

    const account = await accountResp.json();

    if (!accountResp.ok) {
      return res.status(accountResp.status).json({
        error: account?.message || 'Account auth failed',
        statusCode: accountResp.status,
      });
    }

    if (account.trading_blocked || account.account_blocked) {
      return res.json({ action: 'block', reason: 'Account trading blocked' });
    }

    const safeQty = Math.max(1, Math.min(parseInt(qty, 10) || 1, ALPACA_OPTIONS_RISK_CONFIG.MAX_CONTRACTS));

    const orderResp = await fetch('https://api.alpaca.markets/v2/orders', {
      method: 'POST',
      headers: {
        ...alpacaHeaders(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        symbol: signal.optionSymbol,
        qty: String(safeQty),
        side: 'buy',
        type: 'limit',
        time_in_force: 'day',
        limit_price: parseFloat(signal.limitPrice).toFixed(2),
      }),
    });

    const order = await orderResp.json();

    if (!orderResp.ok) {
      return res.status(orderResp.status).json({
        error: order?.message || 'Alpaca order rejected',
        statusCode: orderResp.status,
        alpacaResponse: order,
      });
    }

    orderTimestamps.set(order.id, new Date());
    state.tradesToday++;

    console.log(`[LIVE ORDER] ${signal.optionSymbol} x${safeQty} @ $${signal.limitPrice} — orderId: ${order.id}`);

    res.json({
      action: 'submit',
      orderId: order.id,
      environment: 'live',
    });
  } catch (err) {
    const safeError = {
      message: err?.message || 'Unknown Alpaca order submission error',
      statusCode: err?.statusCode || err?.status || 500,
      code: err?.code || null,
      alpacaMessage:
        err?.response?.message ||
        err?.response?.data?.message ||
        err?.error?.message ||
        null,
    };

    console.error('[live/trade safe error]:', safeError);

    return res.status(safeError.statusCode).json({
      error: safeError.alpacaMessage || safeError.message,
      statusCode: safeError.statusCode,
      code: safeError.code,
    });
  }
});

app.post('/api/alpaca/live/disable', (req, res) => {
  const { reason = 'Manual kill switch' } = req.body;

  resetDailyStateIfNeeded();

  alpacaOptionsRiskState.live.tradingDisabled = true;
  alpacaOptionsRiskState.live.disableReason = reason;

  console.warn(`[AUTO-TRADE DISABLED] env=live reason="${reason}"`);

  res.json({
    success: true,
    reason,
    environment: 'live',
  });
});

app.post('/api/alpaca/live/cancel-stale', async (_req, res) => {
  try {
    const client = getLiveAlpacaClient();
    const now = Date.now();
    const canceled = [];

    for (const [orderId, submittedAt] of orderTimestamps.entries()) {
      if (now - submittedAt.getTime() > ALPACA_OPTIONS_RISK_CONFIG.ORDER_CANCEL_TIMEOUT_MS) {
        try {
          await client.cancelOrder(orderId);
          canceled.push(orderId);
          orderTimestamps.delete(orderId);
        } catch {
          orderTimestamps.delete(orderId);
        }
      }
    }

    res.json({
      canceled,
      environment: 'live',
    });
  } catch (err) {
    console.error('[cancel-stale]:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alpaca/live/order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const client = getLiveAlpacaClient();
    const order = await client.getOrder(orderId);

    res.json({
      id: order.id,
      symbol: order.symbol,
      status: order.status,
      limitPrice: order.limit_price ? parseFloat(order.limit_price) : null,
      filledQty: order.filled_qty ? parseFloat(order.filled_qty) : 0,
      filledAt: order.filled_at ?? null,
      submittedAt: order.submitted_at ?? null,
      side: order.side,
      type: order.order_type,
      environment: 'live',
    });
  } catch (err) {
    console.error('[live/order/:id]:', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/alpaca/live/cancel-order', async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' });
    }

    const client = getLiveAlpacaClient();

    await client.cancelOrder(orderId);
    orderTimestamps.delete(orderId);

    console.log(`[cancel-order] Canceled live order ${orderId}`);

    res.json({
      success: true,
      orderId,
      environment: 'live',
    });
  } catch (err) {
    console.error('[cancel-order]:', err.message);

    if (err.message?.includes('not cancelable') || err.status === 422) {
      return res.json({
        success: true,
        orderId: req.body.orderId,
        note: 'Order already terminal',
        environment: 'live',
      });
    }

    res.status(500).json({ error: err.message });
  }
});

app.get('/api/alpaca/live/account-state', async (_req, res) => {
  try {
    const client = getLiveAlpacaClient();

    const [account, positions] = await Promise.all([
      client.getAccount(),
      client.getPositions(),
    ]);

    res.json({
      ...formatAccount(account),
      dayTradingBuyingPower: parseFloat(account.daytrading_buying_power || account.buying_power || 0),
      openPositionsCount: positions.length,
      environment: 'live',
    });
  } catch (err) {
    console.error('[live/account-state]:', err.message);
    res.status(err.message.includes('not configured') ? 503 : 502).json({ error: err.message });
  }
});

app.post('/api/claude/evaluate', async (req, res) => {
  try {
    const anthropic = getAnthropicClient();

    if (!anthropic) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const { signal, marketContext = {} } = req.body;

    if (!signal || !signal.ticker) {
      return res.status(400).json({ error: 'signal.ticker is required' });
    }

    const prompt = buildTradeEvaluationPrompt(signal, marketContext);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0]?.type === 'text' ? message.content[0].text : '';
    const evaluation = parseClaudeEvaluation(rawText);

    res.json({
      evaluation,
      rawText,
      model: message.model,
    });
  } catch (err) {
    console.error('[claude/evaluate] Error:', err.message);
    res.status(500).json({ error: 'Claude evaluation failed: ' + err.message });
  }
});

app.post('/api/claude/rank', async (req, res) => {
  try {
    const anthropic = getAnthropicClient();

    if (!anthropic) {
      return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured on server' });
    }

    const { signals = [], marketContext = {} } = req.body;

    if (!signals.length) {
      return res.status(400).json({ error: 'signals array is required and must not be empty' });
    }

    const prompt = buildRankingPrompt(signals, marketContext);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawText = message.content[0]?.type === 'text' ? message.content[0].text : '';
    const result = parseRankingResponse(rawText, signals);

    res.json({
      ...result,
      model: message.model,
    });
  } catch (err) {
    console.error('[claude/rank] Error:', err.message);
    res.status(500).json({ error: 'Claude ranking failed: ' + err.message });
  }
});

function buildTradeEvaluationPrompt(signal, marketContext) {
  return `You are a professional options trading risk advisor integrated into the Signal Stack trading system.

Evaluate this trade candidate and respond ONLY in the JSON format specified below.

## Trade Signal
- Ticker: ${signal.ticker}
- Option Symbol: ${signal.optionSymbol || 'N/A'}
- Signal Score: ${signal.totalScore}/20
- Confidence: ${signal.confidence}%
- Grade: ${signal.grade}
- Risk/Reward: 1:${signal.riskReward}
- Market Alignment: ${signal.marketAlignment}
- Bias: ${signal.bias || 'N/A'}
- Entry: $${signal.entry}
- Stop: $${signal.stop}
- Target: $${signal.target}
- Catalyst: ${signal.catalyst || 'None provided'}

## Market Context
- SPY Trend: ${marketContext.spyTrend || 'Unknown'}
- VIX Level: ${marketContext.vixLevel || 'Unknown'}
- Put/Call Ratio: ${marketContext.putCallRatio || 'Unknown'}
- Overall Sentiment: ${marketContext.sentiment || 'Unknown'}

## System Rules
- Signal score must be >= 14
- Confidence must be >= 65%
- R/R must be >= 2
- Grade must be A or A+
- Market alignment must not be BEARISH
- Only limit orders are allowed
- Max 1 contract initially

Respond ONLY with this exact JSON structure:
{
  "advisoryDecision": "APPROVE" | "CAUTION" | "REJECT",
  "tradeThesis": "2-3 sentence explanation of why this trade makes sense or not",
  "riskNotes": ["risk note 1", "risk note 2"],
  "conflictingSignals": ["conflicting signal 1"],
  "confidenceCommentary": "1 sentence commentary on the confidence level"
}`;
}

function buildRankingPrompt(signals, marketContext) {
  const signalList = signals.map((s, i) =>
    `${i + 1}. ${s.ticker} | Score: ${s.totalScore}/20 | Conf: ${s.confidence}% | Grade: ${s.grade} | R/R: 1:${s.riskReward} | Alignment: ${s.marketAlignment}`
  ).join('\n');

  return `You are a professional options trading risk advisor for the Signal Stack system.

## Market Context
- SPY Trend: ${marketContext.spyTrend || 'Unknown'}
- VIX Level: ${marketContext.vixLevel || 'Unknown'}
- Sentiment: ${marketContext.sentiment || 'Unknown'}

## Trade Candidates
${signalList}

Rank these candidates from best to worst opportunity.

Respond ONLY with this exact JSON structure:
{
  "ranked": [
    {
      "ticker": "TICKER",
      "rank": 1,
      "advisoryDecision": "APPROVE" | "CAUTION" | "REJECT",
      "tradeThesis": "brief thesis",
      "riskNotes": ["note"],
      "conflictingSignals": [],
      "confidenceCommentary": "brief comment"
    }
  ],
  "summary": "1-2 sentence overall market assessment"
}`;
}

function parseClaudeEvaluation(rawText) {
  const defaultEvaluation = {
    advisoryDecision: 'CAUTION',
    tradeThesis: 'Claude response could not be parsed.',
    riskNotes: ['Unable to parse Claude response — treat as CAUTION'],
    conflictingSignals: [],
    confidenceCommentary: 'Parse error — defaulting to CAUTION',
  };

  try {
    const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    const validDecisions = ['APPROVE', 'CAUTION', 'REJECT'];

    return {
      advisoryDecision: validDecisions.includes(parsed.advisoryDecision)
        ? parsed.advisoryDecision
        : 'CAUTION',
      tradeThesis: String(parsed.tradeThesis || ''),
      riskNotes: Array.isArray(parsed.riskNotes) ? parsed.riskNotes.map(String) : [],
      conflictingSignals: Array.isArray(parsed.conflictingSignals) ? parsed.conflictingSignals.map(String) : [],
      confidenceCommentary: String(parsed.confidenceCommentary || ''),
    };
  } catch {
    return defaultEvaluation;
  }
}

function parseRankingResponse(rawText, originalSignals) {
  try {
    const clean = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      ranked: Array.isArray(parsed.ranked) ? parsed.ranked : [],
      summary: String(parsed.summary || ''),
    };
  } catch {
    return {
      ranked: originalSignals.map((s, i) => ({
        ticker: s.ticker,
        rank: i + 1,
        advisoryDecision: 'CAUTION',
        tradeThesis: 'Parse error',
        riskNotes: [],
        conflictingSignals: [],
        confidenceCommentary: '',
      })),
      summary: 'Ranking response could not be parsed.',
    };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// OANDA FOREX ROUTES
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/oanda/diagnostics', async (_req, res) => {
  try {
    const result = await runDiagnostics();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oanda/account', (_req, res) => {
  return res.status(410).json({
    error: 'Legacy OANDA account endpoint disabled',
    code: 'LEGACY_OANDA_ACCOUNT_ENDPOINT_DISABLED',
  });
});

app.get('/api/oanda/instruments', async (_req, res) => {
  try {
    const instruments = await getInstruments();
    res.json({ instruments, count: instruments.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oanda/pricing', async (req, res) => {
  try {
    const { instruments } = req.query;
    if (!instruments) {
      return res.status(400).json({ error: 'instruments query param required (e.g. EUR_USD,GBP_USD)' });
    }
    const pairs = instruments.split(',').map((s) => s.trim());
    const prices = await getPricing(pairs);
    res.json({ prices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oanda/candles', async (req, res) => {
  try {
    const { instrument, granularity = 'M15', count = '100' } = req.query;
    if (!instrument) {
      return res.status(400).json({ error: 'instrument query param required' });
    }
    const candles = await getCandles(instrument, granularity, parseInt(count, 10));
    res.json({ instrument, granularity, count: candles.length, candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



app.post('/api/oanda/close', async (req, res) => {
  try {
    const { instrument } = req.body;
    if (!instrument) {
      return res.status(400).json({ error: 'Request body must contain instrument' });
    }
    const result = await closePosition(instrument);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/oanda/trade-state', (_req, res) => {
  res.json(getTradeState());
});

// DEV-ONLY: clear in-memory duplicate-trade guard + daily counters + cooldown.
// Does NOT close broker positions or contact OANDA — purely local state.
app.post('/api/oanda/trade-state/reset', (_req, res) => {
  const result = resetDailyCounters();
  res.json({ ...result, tradeState: getTradeState() });
});

app.get('/api/oanda/signals', (_req, res) => {
  res.json(getLatestSignals());
});

app.get('/api/oanda/trade-history', (req, res) => {
  const limit = parseInt(req.query.limit || '100', 10);
  const history = getTradeHistory(limit);
  res.json({ history, count: history.length });
});

app.get('/api/oanda/performance', (_req, res) => {
  const stats = getPerformanceStats();
  res.json({ stats, count: stats.length });
});

app.get('/api/oanda/exit-manager/status', (_req, res) => {
  res.json({ ok: true, exitManager: getExitManagerStatus() });
});

// Re-runs the macro/structure/momentum waterfall against each open OANDA trade
// and returns trade state + exit recommendation per position. Read-only — does
// not place or close orders.
app.get('/api/oanda/active-trades/analysis', async (_req, res) => {
  try {
    const result = await analyzeActiveTrades();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// Active-trade reassessment (2026-05-27 upgrade — trailing / partials / TP-reduction /
// invalidation / volatility collapse / profit protection). Recommendations only —
// see Part 12 of the spec.
app.get('/api/oanda/active-trades/reassess', async (_req, res) => {
  try {
    const result = await reassessActiveTrades();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// INTERNAL endpoints — called by the Next.js Route Handlers with credentials
// resolved from the authenticated user's broker_connections row.
//
// Authentication: a shared secret in the X-Internal-Auth header. This is NOT
// exposed to the browser — only the Next.js server (running inside the same
// trust boundary) knows the secret. The shared secret is rotated by ops, not
// per-user.
//
// Per-request body: { apiKey, accountId, baseUrl, environment, ... }
//   - apiKey/accountId/baseUrl are the decrypted broker credentials for ONE user
//   - environment is informational only — baseUrl is authoritative
//
// Hard-fails when any credential is missing — never falls back to env.
// ══════════════════════════════════════════════════════════════════════════════

function requireInternalAuth(req, res) {
  const expected = process.env.SCANNER_INTERNAL_SECRET;
  if (!expected) {
    res.status(500).json({ ok: false, error: 'SCANNER_INTERNAL_SECRET is not configured on the scanner' });
    return false;
  }
  const got = req.header('x-internal-auth') || '';
  if (got !== expected) {
    res.status(401).json({ ok: false, error: 'Invalid or missing X-Internal-Auth header' });
    return false;
  }
  return true;
}

function maskAccountId(accountId) {
  if (!accountId || typeof accountId !== 'string') return '<none>';
  if (accountId.length <= 4) return '***';
  return `${accountId.slice(0, 3)}…${accountId.slice(-3)}`;
}

// Reused by every /api/internal/oanda/* endpoint to assert post-call sanity:
// the per-request client's accountId must match what we forwarded.
function assertClientMatchesRequest(client, body) {
  if (!client) {
    throw new Error('assertClientMatchesRequest: client is missing — refusing to run');
  }
  if (client.isDefault) {
    throw new Error(
      'assertClientMatchesRequest: per-request client is flagged isDefault=true — refusing to run user request',
    );
  }
  if (body?.accountId && client.accountId !== body.accountId) {
    throw new Error(
      `assertClientMatchesRequest: client.accountId="${maskAccountId(client.accountId)}" ` +
        `does not match request body accountId="${maskAccountId(body.accountId)}"`,
    );
  }
}

function buildClientFromBody(body, res) {
  const { apiKey, accountId, baseUrl, environment } = body || {};
  if (!apiKey)    { res.status(400).json({ ok: false, error: 'Missing apiKey in body' });    return null; }
  if (!accountId) { res.status(400).json({ ok: false, error: 'Missing accountId in body' }); return null; }
  if (!baseUrl)   { res.status(400).json({ ok: false, error: 'Missing baseUrl in body' });   return null; }
  try {
    const client = createOandaClient({ apiKey, accountId, baseUrl, environment });
    // Guardrail: any internal-endpoint call MUST use the per-request client.
    // Surface a structured log with masked accountId. Never log apiKey/token.
    return client;
  } catch (err) {
    res.status(400).json({ ok: false, error: err?.message || String(err) });
    return null;
  }
}

function logInternalCall(tag, body) {
  const env = body?.environment ?? '<missing>';
  const accountId = body?.accountId;
  console.log(
    `[INTERNAL ${tag}] broker=oanda env=${env} accountId=${maskAccountId(accountId)} usingDefaultClient=false`,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// INTERNAL endpoints — FUTURES providers (NinjaTrader, Topstep).
//
// Kept physically separate from the /api/internal/oanda/* forex endpoints. Each
// route asserts its own provider against the credential provider via
// assertExecutionProvider() so a futures order can NEVER route through OANDA and
// an OANDA request can never reach a futures connector. Credentials arrive as a
// decrypted multi-field object in the body (NOT apiKey/accountId/baseUrl).
// ══════════════════════════════════════════════════════════════════════════════

function logFuturesCall(provider, op, body) {
  console.log(`[INTERNAL ${provider.toUpperCase()} ${op}] env=${body?.environment ?? '<missing>'} mode=futures`);
}

// Safe diagnostics log — reports PRESENCE only, never values. Lists which
// required credential fields arrived and whether the gateway URL is configured.
function logFuturesDiag(provider, body, gatewayEnvVar) {
  const creds = body?.credentials || {};
  const fields = provider === 'ninjatrader'
    ? ['name', 'password', 'appId', 'appVersion', 'cid', 'sec']
    : ['userName', 'apiKey'];
  const present = fields.filter((f) => creds[f] != null && String(creds[f]).trim() !== '');
  const missing = fields.filter((f) => !present.includes(f));
  console.log(
    `[INTERNAL ${provider.toUpperCase()} DIAGNOSTICS] env=${body?.environment ?? '<missing>'} ` +
    `fieldsPresent=[${present.join(',')}] fieldsMissing=[${missing.join(',')}] ` +
    `gatewayUrl=${process.env[gatewayEnvVar] ? 'present' : 'default'}`,
  );
}

// Wrap a futures handler: internal-auth, provider assertion, error envelope.
function futuresRoute(routeProvider, handler) {
  return async (req, res) => {
    if (!requireInternalAuth(req, res)) return;
    const body = req.body || {};
    try {
      // The body declares which provider it carries; it MUST match the route.
      assertExecutionProvider(routeProvider, body.provider);
    } catch (err) {
      return res.status(409).json({ ok: false, error: err?.message || String(err), code: err?.code });
    }
    if (!body.credentials || typeof body.credentials !== 'object') {
      return res.status(400).json({ ok: false, error: 'Missing credentials object in body' });
    }
    try {
      await handler(body, res);
    } catch (err) {
      console.error(`[INTERNAL_${routeProvider.toUpperCase()}] error:`, err?.message || err);
      res.status(500).json({ ok: false, error: err?.message || String(err) });
    }
  };
}

// ─── NinjaTrader ────────────────────────────────────────────────────────────
app.post('/api/internal/ninjatrader/validate', futuresRoute(PROVIDERS.NINJATRADER, async (body, res) => {
  logFuturesCall('ninjatrader', 'VALIDATE', body);
  const result = await ninjaTraderConnectivityCheck({ credentials: body.credentials, environment: body.environment });
  res.json({ ok: result.ok, status: result.status, error: result.error ?? null, missing: result.missing ?? [] });
}));

app.post('/api/internal/ninjatrader/diagnostics', futuresRoute(PROVIDERS.NINJATRADER, async (body, res) => {
  logFuturesDiag('ninjatrader', body, 'NINJATRADER_GATEWAY_URL');
  const diag = await getNinjaTraderDiagnostics({ credentials: body.credentials, environment: body.environment });
  res.json(diag);
}));

app.post('/api/internal/ninjatrader/status', futuresRoute(PROVIDERS.NINJATRADER, async (body, res) => {
  logFuturesCall('ninjatrader', 'STATUS', body);
  if (!ninjaTraderFuturesEnabled()) {
    return res.json({ ok: true, enabled: false, accounts: [], positions: [], reason: 'NinjaTrader provider disabled' });
  }
  const client = buildNinjaTraderClient({ credentials: body.credentials, environment: body.environment });
  await client.authenticate();
  const accounts = await getNinjaTraderAccounts(client);
  const positions = await getNinjaTraderPositions(client, { accountId: body.accountId });
  res.json({ ok: true, enabled: true, mode: client.mode, accounts, positions });
}));

app.post('/api/internal/ninjatrader/trade', futuresRoute(PROVIDERS.NINJATRADER, async (body, res) => {
  logFuturesCall('ninjatrader', 'TRADE', body);
  const client = buildNinjaTraderClient({ credentials: body.credentials, environment: body.environment });
  await client.authenticate();
  const result = await placeNinjaTraderOrder(client, body.order || {});
  res.json(result);
}));

app.post('/api/internal/ninjatrader/close', futuresRoute(PROVIDERS.NINJATRADER, async (body, res) => {
  logFuturesCall('ninjatrader', 'CLOSE', body);
  const client = buildNinjaTraderClient({ credentials: body.credentials, environment: body.environment });
  await client.authenticate();
  const result = await closeNinjaTraderPosition(client, body.position || {});
  res.json(result);
}));

// ─── Topstep ──────────────────────────────────────────────────────────────────
app.post('/api/internal/topstep/validate', futuresRoute(PROVIDERS.TOPSTEP, async (body, res) => {
  logFuturesCall('topstep', 'VALIDATE', body);
  const result = await topstepConnectivityCheck({ credentials: body.credentials, environment: body.environment });
  res.json({ ok: result.ok, status: result.status, error: result.error ?? null, missing: result.missing ?? [] });
}));

app.post('/api/internal/topstep/diagnostics', futuresRoute(PROVIDERS.TOPSTEP, async (body, res) => {
  logFuturesDiag('topstep', body, 'TOPSTEP_API_BASE_URL');
  const diag = await getTopstepDiagnostics({ credentials: body.credentials, environment: body.environment });
  res.json(diag);
}));

app.post('/api/internal/topstep/status', futuresRoute(PROVIDERS.TOPSTEP, async (body, res) => {
  logFuturesCall('topstep', 'STATUS', body);
  if (!topstepEnabled()) {
    return res.json({ ok: true, enabled: false, accounts: [], positions: [], reason: 'Topstep provider disabled' });
  }
  const client = buildTopstepClient({ credentials: body.credentials, environment: body.environment });
  await client.authenticate();
  const accounts = await getTopstepAccounts(client);
  const positions = await getTopstepPositions(client, { accountId: body.accountId });
  const execGate = evaluateTopstepExecution({ environment: body.environment });
  res.json({ ok: true, enabled: true, mode: client.mode, accounts, positions, executionAllowed: execGate.allowed, executionReason: execGate.reason });
}));

app.post('/api/internal/topstep/trade', futuresRoute(PROVIDERS.TOPSTEP, async (body, res) => {
  logFuturesCall('topstep', 'TRADE', body);
  const client = buildTopstepClient({ credentials: body.credentials, environment: body.environment });
  await client.authenticate();
  const result = await placeTopstepOrder(client, body.order || {});
  res.json(result);
}));

app.post('/api/internal/topstep/close', futuresRoute(PROVIDERS.TOPSTEP, async (body, res) => {
  logFuturesCall('topstep', 'CLOSE', body);
  const client = buildTopstepClient({ credentials: body.credentials, environment: body.environment });
  await client.authenticate();
  const result = await closeTopstepPosition(client, body.position || {});
  res.json(result);
}));

// POST /api/internal/oanda/risk-status
//   Read-only risk snapshot for the dashboard Risk Management panel: account
//   balance + central risk-manager state (per-trade cap, daily drawdown lock,
//   auto-execution confidence threshold). Does NOT place or change anything.
app.post('/api/internal/oanda/risk-status', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('RISK_STATUS', req.body);
  try {
    const account = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => getAccountSummary({ client }),
    );
    const balanceUSD = parseFloat(account?.balance ?? 0);
    const status = getRiskStatus({ accountId: client.accountId, balanceUSD });
    res.json({ ok: true, ...status });
  } catch (err) {
    console.error('[INTERNAL_RISK_STATUS] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});


// POST /api/internal/oanda/risk-reset
//   Authenticated account-scoped reset of today's in-memory daily-loss baseline.
//   The new baseline is immediately re-seeded from the broker's current balance.
app.post('/api/internal/oanda/risk-reset', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('RISK_RESET', req.body);
  try {
    const account = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => getAccountSummary({ client }),
    );
    const balanceUSD = parseFloat(account?.balance ?? 0);
    const reset = resetDailyRisk(client.accountId);
    const status = getRiskStatus({ accountId: client.accountId, balanceUSD });
    console.log(
      `[INTERNAL_RISK_RESET] accountId=${maskAccountId(client.accountId)} ` +
      `startingBalance=${status.dailyStartingBalance} tradingLocked=${status.tradingLocked}`,
    );
    res.json({ ok: true, reset, ...status });
  } catch (err) {
    console.error('[INTERNAL_RISK_RESET] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/scan

// POST /api/internal/oanda/v3-scan
// Dashboard-only native V3 analysis. This route reads raw user-scoped OANDA
// pricing/candles and evaluates V3 Stage 1 followed by V3 Stage 2. It never
// invokes or consumes ICT, PPR, or retired legacy strategy logic.
app.post('/api/internal/oanda/v3-scan', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('V3_SCAN', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runV3DashboardScan({
        client,
        pairs: req.body?.pairs || null,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL V3_SCAN] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
    );
    console.log(
      `[INTERNAL V3_SCAN] complete accountId=${maskAccountId(client.accountId)} ` +
        `scanner=v3_independent foreignStrategyInputs=false ` +
        `qualified=${result?.qualified?.length ?? 0} ` +
        `near=${result?.nearQualified?.length ?? 0} ` +
        `hot=${result?.hotWatch?.length ?? 0} ` +
        `rejected=${result?.rejected?.length ?? 0}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_V3_SCAN] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/ppr-scan
// User-scoped PPR scan. When autoExecute=true, every signal classified as
// qualified in THIS SAME scan is immediately submitted to the native PPR
// executor. Practice/paper execution remains supported; live-only safeguards
// still apply only to live accounts.
app.post('/api/internal/oanda/ppr-scan', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('PPR_SCAN', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => scanPprMarket({
        client,
        pairs: req.body?.pairs || null,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL PPR_SCAN] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
    );

    const autoExecute = req.body?.autoExecute === true;
    const qualified = Array.isArray(result?.qualified) ? result.qualified : [];
    const executed = [];
    const skipped = [];
    const readiness = result?.meta?.executionReadiness || null;

    if (autoExecute && readiness?.orderSubmissionReady !== false) {
      for (const signal of qualified) {
        const tradeResult = await runUserScoped(
          { accountId: client.accountId, environment: client.environment },
          () => executePprTrade(signal, {
            client,
            now: new Date(),
            log: (message) => console.log(
              `[INTERNAL PPR_EXECUTE] accountId=${maskAccountId(client.accountId)} ${message}`,
            ),
          }),
        );
        if (tradeResult?.success) {
          executed.push({
            pair: signal.pair,
            direction: signal.direction,
            confidence: signal.confidence,
            expectedRR: signal.expectedRR,
            tradeId: tradeResult.tradeId,
            fillPrice: tradeResult.fillPrice,
            units: tradeResult.units,
            stopLoss: tradeResult.sizing?.stopLoss ?? signal.stopLoss,
            takeProfit: tradeResult.sizing?.takeProfit ?? signal.takeProfit,
          });
        } else {
          skipped.push({
            pair: signal.pair,
            direction: signal.direction,
            confidence: signal.confidence,
            expectedRR: signal.expectedRR,
            reason: tradeResult?.reason || tradeResult?.rejectReason || 'execution failed',
            executionState: tradeResult?.executionState || null,
          });
        }
      }
    } else if (autoExecute) {
      const reason = readiness?.blockers?.join('; ') || 'PPR order submission is not ready';
      for (const signal of qualified) {
        skipped.push({ pair: signal.pair, direction: signal.direction, reason });
      }
    }

    const execution = {
      enabled: autoExecute,
      environment: client.environment,
      qualified: qualified.length,
      attempted: autoExecute ? qualified.length : 0,
      executed,
      skipped,
      executedCount: executed.length,
      skippedCount: skipped.length,
      allQualifiedAttempted: !autoExecute || executed.length + skipped.length === qualified.length,
    };
    result.execution = execution;
    result.meta = { ...(result.meta || {}), execution };

    console.log(
      `[INTERNAL PPR_SCAN] complete accountId=${maskAccountId(client.accountId)} ` +
        `engine=ppr architecture=independent_ppr_raw_market_data ` +
        `legacyScannerUsed=false v3LogicUsed=false ictLogicUsed=false ` +
        `qualified=${qualified.length} watch=${result?.watchCandidates?.length ?? 0} ` +
        `rejected=${result?.rejected?.length ?? 0} autoExecute=${autoExecute} ` +
        `attempted=${execution.attempted} executed=${execution.executedCount} skipped=${execution.skippedCount}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_PPR_SCAN] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/ict
//   Standalone ICT-first analysis (shadow only — never trades). Body may carry
//   { pairs } to scope; otherwise the ICT watchlist is used.
app.post('/api/internal/oanda/ict', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('ICT', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => analyzeICTPairs(req.body?.pairs || null, { client }),
    );
    console.log(
      `[INTERNAL ICT] complete accountId=${maskAccountId(client.accountId)} ` +
        `pairs=${result?.meta?.pairsAnalyzed ?? 0} signals=${result?.meta?.signals ?? 0}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_ICT] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/ict/trade
//   Body: { apiKey, accountId, baseUrl, environment, pair, direction, units,
//           entry, stopLoss, targetProfit, ictSignalId }
//   Manual ICT execution. Requires environment=live (per-user creds only — no
//   env fallback). The executor itself enforces the ICT flags + live-ack +
//   server-side signal recompute + shared duplicate lock. Isolated from V3.
app.post('/api/internal/oanda/ict/trade', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  const env = String(req.body?.environment ?? '').toLowerCase();
  if (!isExecutableEnvironment(env)) {
    res.status(400).json({ ok: false, error: `ICT trade endpoint requires environment=live|practice|paper (got "${env || '<empty>'}")` });
    return;
  }
  assertClientMatchesRequest(client, req.body);
  logInternalCall('ICT_TRADE', req.body);
  try {
    const { pair, direction, units, entry, stopLoss, targetProfit, ictSignalId } = req.body || {};
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeIctTrade({ pair, direction, units, entry, stopLoss, targetProfit, ictSignalId }, { client }),
    );
    console.log(
      `[INTERNAL ICT_TRADE] accountId=${maskAccountId(client.accountId)} ` +
        `pair=${pair} dir=${direction} state=${result?.executionState ?? '?'} success=${result?.success === true}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_ICT_TRADE] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/ict/auto
//   Autonomous ICT entry for ONE user. The Next cron resolves the user's creds
//   and forwards them here; the executor enforces every gate (off by default).
app.post('/api/internal/oanda/ict/auto', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  const env = String(req.body?.environment ?? '').toLowerCase();
  if (!isExecutableEnvironment(env)) {
    res.status(400).json({ ok: false, error: `ICT auto endpoint requires environment=live|practice|paper (got "${env || '<empty>'}")` });
    return;
  }
  assertClientMatchesRequest(client, req.body);
  logInternalCall('ICT_AUTO', req.body);
  const scanMode = ['full', 'near_recheck', 'hot_watch', 'daily_study'].includes(String(req.body?.scanMode || 'full'))
    ? String(req.body?.scanMode || 'full')
    : 'full';
  const pairs = Array.isArray(req.body?.pairs)
    ? req.body.pairs.map((p) => String(p).trim()).filter(Boolean)
    : null;
  console.log(`[AUTO_AI][ICT] scanMode=${scanMode} pairs=${pairs?.length ? pairs.join(',') : 'ALL'}`);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runAutoAiForUser({ client, runId: req.body?.runId, scanMode, pairs }),
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_ICT_AUTO] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/auto
//   Engine-routed autonomous entry for ONE user. Body.engine selects EXACTLY one
//   path (ICT or V3) — never both. Requires environment=live (per-user creds).
//   Each engine's own execution gates are enforced downstream (unchanged).
app.post('/api/internal/oanda/auto', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  const env = String(req.body?.environment ?? '').toLowerCase();
  if (!isExecutableEnvironment(env)) {
    res.status(400).json({ ok: false, error: `auto endpoint requires environment=live|practice|paper (got "${env || '<empty>'}")` });
    return;
  }
  assertClientMatchesRequest(client, req.body);
  const requestedEngine = String(req.body?.engine || 'ict').toLowerCase();
  const engine = ['ict', 'v3', 'ppr'].includes(requestedEngine) ? requestedEngine : 'ict';
  const scanMode = ['full', 'near_recheck', 'hot_watch', 'daily_study'].includes(String(req.body?.scanMode || 'full'))
    ? String(req.body?.scanMode || 'full')
    : 'full';
  const pairs = Array.isArray(req.body?.pairs)
    ? req.body.pairs.map((p) => String(p).trim()).filter(Boolean)
    : null;
  logInternalCall(`AUTO_${engine.toUpperCase()}`, req.body);
  console.log(`[AUTO_AI][${engine.toUpperCase()}] scanMode=${scanMode} pairs=${pairs?.length ? pairs.join(',') : 'ALL'}`);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runAutoForUser({ client, engine, runId: req.body?.runId, scanMode, pairs }),
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_AUTO] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/ict/reassess
//   ICT lifecycle reassessment — RECOMMEND-ONLY (does not close/modify unless
//   ICT_AUTO_MANAGE=true, which is out of scope here). Body carries the user's
//   open ICT trades (from trade_logs) + creds; we fetch fresh candles per pair
//   and return management recommendations for logging/surfacing.
app.post('/api/internal/oanda/ict/reassess', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('ICT_REASSESS', req.body);
  const trades = Array.isArray(req.body?.trades) ? req.body.trades : [];
  try {
    const recommendations = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      async () => {
        const out = [];
        for (const t of trades) {
          const candles = await getCandles(t.pair, 'M5', 120, { client }).catch(() => []);
          const currentPrice = candles.length ? candles[candles.length - 1].close : null;
          const r = reassessIctTrade({
            pair: t.pair, direction: t.direction, entryPrice: t.entryPrice, currentPrice,
            target1: t.target1, candles, now: new Date(),
            openedAtMs: t.openedAtMs, holdMinutes: t.holdMinutes, lastReassessMs: t.lastReassessMs ?? null,
          });
          if (r.reassessDue) console.log(`[ICT_LIFECYCLE] ${t.pair} ${t.direction} → ${r.action} (${r.reasons[0]})`);
          out.push({ tradeId: t.tradeId, pair: t.pair, ...r });
        }
        return out;
      },
    );
    const dueCount = recommendations.filter((r) => r.reassessDue).length;
    console.log(`[AUTO_AI][ICT][runId=${req.body?.runId ?? '-'}] account=${maskAccountId(client.accountId)} independentFromV3=true reassess trades=${trades.length} recommendations=${dueCount}`);
    res.json({ ok: true, recommendations, autoManage: String(process.env.ICT_AUTO_MANAGE || 'false').toLowerCase() === 'true' });
  } catch (err) {
    console.error('[INTERNAL_ICT_REASSESS] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/active-trades/analysis
app.post('/api/internal/oanda/active-trades/analysis', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('ANALYSIS', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => analyzeActiveTrades({ client }),
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_ANALYSIS] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/active-trades/reassess
app.post('/api/internal/oanda/active-trades/reassess', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('REASSESS', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => reassessActiveTrades({ client }),
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_REASSESS] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/close
//   Body: { apiKey, accountId, baseUrl, environment, tradeId, instrument, units }
//   units: omitted | 'ALL' → full close. Numeric → partial.
//   Auth: X-Internal-Auth. Builds per-request client; runs inside runUserScoped
//   so any helper that forgets { client } throws the cross-tenant guard.
app.post('/api/internal/oanda/close', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  const { tradeId, instrument, units } = req.body || {};
  if (!tradeId || typeof tradeId !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing tradeId in body' });
    return;
  }
  if (units != null && String(units).toUpperCase() !== 'ALL') {
    const n = Number(units);
    if (!Number.isFinite(n) || n <= 0) {
      res.status(400).json({ ok: false, error: 'Invalid units (must be ALL or positive number)' });
      return;
    }
  }
  logInternalCall('CLOSE', req.body);
  console.log(
    `[INTERNAL CLOSE] tradeId=${tradeId} instrument=${instrument ?? '?'} units=${units ?? 'ALL'}`,
  );
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => closeBrokerTrade({ tradeId, instrument, units, client }),
    );
    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_CLOSE] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/protection
//   Body: { apiKey, accountId, baseUrl, environment, tradeId, instrument,
//           stopLoss, cancelTakeProfit }
//   Protection-only mutation: it can improve a stop to/through breakeven and
//   remove a fixed TP for a runner, but it cannot close a trade or widen risk.
app.post('/api/internal/oanda/protection', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  const { tradeId, instrument, stopLoss, cancelTakeProfit } = req.body || {};
  if (!tradeId || typeof tradeId !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing tradeId in body' });
    return;
  }
  if (stopLoss != null && !Number.isFinite(Number(stopLoss))) {
    res.status(400).json({ ok: false, error: 'Invalid stopLoss (must be a finite number)' });
    return;
  }
  if (stopLoss == null && cancelTakeProfit !== true) {
    res.status(400).json({ ok: false, error: 'No protection update requested' });
    return;
  }
  logInternalCall('PROTECTION', req.body);
  console.log(
    `[INTERNAL PROTECTION] tradeId=${tradeId} instrument=${instrument ?? '?'} ` +
      `stopLoss=${stopLoss ?? 'unchanged'} cancelTakeProfit=${cancelTakeProfit === true}`,
  );
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => updateBrokerTradeProtection({
        tradeId,
        instrument,
        stopLoss,
        cancelTakeProfit: cancelTakeProfit === true,
        client,
      }),
    );
    if (!result.ok) {
      res.status(502).json(result);
      return;
    }
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_PROTECTION] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// POST /api/internal/oanda/calibration
//   No OANDA client required — this is read-only over the trade-history file
//   (which is platform-wide today; will become per-user when history moves to
//   Supabase). Auth still via X-Internal-Auth so it can't be reached from the
//   browser.
app.post('/api/internal/oanda/calibration', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  try {
    const snapshot = getCalibrationSnapshot(getTradeHistory(1000));
    console.log(
      `[INTERNAL CALIBRATION] threshold=${snapshot.calibratedRejectionThreshold} ` +
        `samples=${snapshot.rolling.sampleCount} eligible=${snapshot.eligibleForAdjustment}`,
    );
    res.json(snapshot);
  } catch (err) {
    console.error('[INTERNAL_CALIBRATION] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});


// POST /api/internal/oanda/v3-trade
//   V3-only manual execution for a completed Recent Signals candidate.
//   The exact pair is refreshed from raw OANDA data and must pass current native
//   V3 Stage 1, Stage 2, direction-lock, and geometry checks before broker handoff.
app.post('/api/internal/oanda/v3-trade', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  const signal = req.body?.signal;
  if (!signal || typeof signal !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing V3 signal in body' });
    return;
  }
  if (!signal.pair || typeof signal.pair !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid V3 signal.pair' });
    return;
  }
  if (signal.direction !== 'long' && signal.direction !== 'short') {
    res.status(400).json({ ok: false, error: 'Invalid V3 signal.direction (must be long or short)' });
    return;
  }
  const env = String(req.body?.environment ?? '').toLowerCase();
  if (!isExecutableEnvironment(env)) {
    res.status(400).json({
      ok: false,
      error: `V3 trade endpoint requires environment=live|practice|paper (got "${env || '<empty>'}")`,
    });
    return;
  }
  assertClientMatchesRequest(client, req.body);
  logInternalCall('V3_TRADE', req.body);
  signal.environment = env;
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeRecentQualifiedV3Signal({
        signal,
        client,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL V3 RECENT SIGNAL] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_V3_TRADE] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════

// API guard — must be LAST middleware, before app.listen. Prevents any
// unmatched /api/* path from ever falling through to a static catch-all.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'API route not found', path: req.originalUrl });
});

console.log('USING LIVE-ONLY SERVER INDEX FILE');


// GET /api/internal/ftmo/validate
//   Validates FTMO/cTrader connector configuration. Does not execute trades.
app.get('/api/internal/ftmo/validate', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;

  try {
    const validation = validateFtmoCredentials();

    if (!validation.ok) {
      res.status(400).json({
        ok: false,
        provider: 'ftmo',
        adapter: 'ctrader',
        error: validation.error,
        missing: validation.missing,
      });
      return;
    }

    const client = buildFtmoClient();

    res.json({
      ok: true,
      provider: 'ftmo',
      adapter: 'ctrader',
      accountId: client.accountId ? `${String(client.accountId).slice(0, 3)}…${String(client.accountId).slice(-3)}` : null,
      liveExecutionEnabled: client.config.liveExecutionEnabled,
      autoTradeEnabled: client.config.autoTradeEnabled,
      useV3: client.config.useV3,
      useICT: client.config.useICT,
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      provider: 'ftmo',
      adapter: 'ctrader',
      error: err?.message || String(err),
      missing: err?.missing || [],
    });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`Trading API Server running on port ${PORT}`);
  console.log(`Alpaca mode: LIVE ONLY`);
  console.log(`Shadow mode: ${SHADOW_MODE ? 'ON (no real orders)' : 'OFF (LIVE ORDERS ENABLED)'}`);
  // Signal Stack V3 engine mode at boot — confirms FOREX_V3_ENGINE_MODE reached
  // THIS service/process. `off` ⇒ evaluateV3() never runs and every signal.v3 is null.
  console.log(`[V3] FOREX_V3_ENGINE_MODE=${process.env.FOREX_V3_ENGINE_MODE ?? '(unset)'} → resolved V3_MODE='${V3_MODE}' (${V3_MODE === 'off' ? 'V3 OFF — no v3 on signals' : 'V3 ON'})`);
  // ICT engine is shadow-only analysis (never trades); 'off' disables the tab's data.
  const ictExecutionEnabled =
    process.env.ICT_ENGINE_MODE === 'live' &&
    process.env.ICT_AUTO_TRADE_ENABLED === 'true';

  console.log(
    `[ICT] mode=${process.env.ICT_ENGINE_MODE || 'shadow'} ` +
    `autoTrade=${process.env.ICT_AUTO_TRADE_ENABLED === 'true'} ` +
    `executionEnabled=${ictExecutionEnabled} ` +
    `minConfidence=${process.env.ICT_MIN_CONFIDENCE || 80} ` +
    `minRR=${process.env.ICT_MIN_RR || 2.0} ` +
    `maxRiskPercent=${process.env.ICT_MAX_RISK_PERCENT || 1} ` +
    `signalTtlSec=${process.env.ICT_SIGNAL_TTL_SEC || 300}`
  );
  console.log(`Claude Advisor: ${process.env.ANTHROPIC_API_KEY ? 'Configured' : 'NOT CONFIGURED (set ANTHROPIC_API_KEY)'}`);
  console.log(`Frontend URL: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);

  // Env-guarded active-trade reassessment scheduler — Part 10 of the
  // 2026-05-27 active-trade-management upgrade. Default OFF.
  startReassessmentScheduler();
  // ICT Phase 2 — autonomous auto-AI scheduler (Railway 5-min loop → Next cron).
  // Default OFF (ICT_AUTO_AI_SCHEDULER_ENABLED). Triggers per-user ICT auto-trading
  // only on NY weekdays 02:00–11:00 ET; all execution gates still apply downstream.
  startAutoAiScheduler();
  console.log(`OANDA env:    ${process.env.OANDA_ENV || 'practice'}`);
  console.log(`Auto-trade:   ${process.env.FOREX_AUTO_TRADE_ENABLED || 'false'}`);
  console.log(`Min score:    ${process.env.FOREX_MIN_SCORE || '15'}/20`);
  console.log(`Min conf:     ${process.env.FOREX_MIN_CONFIDENCE || '85'}%`);
  console.log(`Max spread:   ${process.env.FOREX_MAX_SPREAD_PIPS || '2.0'} pips`);

  // Startup reconciliation — wipe any stale in-memory trade locks that no longer
  // correspond to a live OANDA position. Critical after restarts.
  reconcileAllLocks('startup')
    .then(s => console.log(`[STARTUP RECONCILE] ${JSON.stringify({ verified: s.verified, kept: s.kept, stale: s.stale, staleKeys: s.staleKeys, locksAfter: s.locksAfter })}`))
    .catch(err => console.warn(`[STARTUP RECONCILE] failed: ${err?.message || err}`));

  // Legacy server-side exit manager uses env-based OANDA credentials.
  // In multi-tenant production, keep it disabled unless explicitly allowed.
  if (
    process.env.FOREX_AUTO_TRADE_ENABLED === 'true' &&
    process.env.ENABLE_LEGACY_EXIT_MANAGER === 'true'
  ) {
    startExitManager();
  } else {
    console.log(
      `[EXIT_MANAGER] Not started — legacy env-based exit manager disabled ` +
      `(FOREX_AUTO_TRADE_ENABLED=${process.env.FOREX_AUTO_TRADE_ENABLED || 'false'}, ` +
      `ENABLE_LEGACY_EXIT_MANAGER=${process.env.ENABLE_LEGACY_EXIT_MANAGER || 'false'})`
    );
  }
});
