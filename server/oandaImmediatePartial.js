/**
 * Event-driven OANDA partial-profit manager.
 *
 * The existing exit manager remains responsible for its slower reconciliation,
 * breakeven and trailing work. This module owns the latency-sensitive +15 pip
 * milestone: every OANDA PRICE event is evaluated using the executable close
 * side (bid for longs, ask for shorts), and one 50% partial is submitted as
 * soon as that threshold is observed.
 *
 * One pricing stream is maintained per broker account. Request-scoped OANDA
 * clients are supported so multi-tenant execution never falls back to another
 * account's credentials.
 */

import {
  getAccountId,
  getEnvironment,
  getOandaBaseUrl,
  oandaHeaders,
  oandaGet,
  oandaPut,
} from './oandaClient.js';

export const IMMEDIATE_PARTIAL_TRIGGER_PIPS = 15.0;
export const IMMEDIATE_PARTIAL_PERCENT = 0.50;
const RECONNECT_DELAY_MS = 1_000;

const accounts = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedInstrument(value) {
  return String(value || '').trim().toUpperCase().replace('/', '_');
}

export function pipSizeForImmediatePartial(instrument) {
  const pair = normalizedInstrument(instrument);
  if (pair.includes('JPY')) return 0.01;
  if (pair === 'XAU_USD' || pair === 'XAG_USD') return 0.01;
  return 0.0001;
}

export function executablePriceForImmediatePartial({ currentUnits, bid, ask }) {
  const units = Number(currentUnits);
  const bidNumber = Number(bid);
  const askNumber = Number(ask);
  if (!Number.isFinite(units) || units === 0) return null;
  const price = units > 0 ? bidNumber : askNumber;
  return Number.isFinite(price) && price > 0 ? price : null;
}

export function profitPipsForImmediatePartial({ instrument, entryPrice, currentUnits, bid, ask }) {
  const entry = Number(entryPrice);
  const units = Number(currentUnits);
  const executablePrice = executablePriceForImmediatePartial({ currentUnits: units, bid, ask });
  if (!Number.isFinite(entry) || entry <= 0 || executablePrice == null) return null;
  const distance = units > 0 ? executablePrice - entry : entry - executablePrice;
  return distance / pipSizeForImmediatePartial(instrument);
}

export function partialUnitsForImmediateClose(currentUnits) {
  const totalUnits = Math.abs(Math.trunc(Number(currentUnits)));
  if (!Number.isFinite(totalUnits) || totalUnits < 2) return null;
  return Math.max(
    1,
    Math.min(Math.round(totalUnits * IMMEDIATE_PARTIAL_PERCENT), totalUnits - 1),
  );
}

export function brokerTradeAlreadyReduced(initialUnits, currentUnits) {
  const initial = Math.abs(Number(initialUnits));
  const current = Math.abs(Number(currentUnits));
  return Number.isFinite(initial) && Number.isFinite(current) && initial > 0 && current < initial;
}

function streamBaseUrl(baseUrl, environment) {
  const env = environment === 'live' ? 'live' : 'practice';
  try {
    const parsed = new URL(baseUrl || '');
    if (parsed.hostname === 'api-fxtrade.oanda.com') {
      parsed.hostname = 'stream-fxtrade.oanda.com';
      return parsed.origin;
    }
    if (parsed.hostname === 'api-fxpractice.oanda.com') {
      parsed.hostname = 'stream-fxpractice.oanda.com';
      return parsed.origin;
    }
  } catch {
    // Fall through to the canonical OANDA streaming host below.
  }
  return env === 'live'
    ? 'https://stream-fxtrade.oanda.com'
    : 'https://stream-fxpractice.oanda.com';
}

function contextFromClient(client) {
  if (client) {
    if (!client.accountId || !client.apiKey || !client.baseUrl) {
      throw new Error('Immediate partial stream requires client accountId, apiKey and baseUrl');
    }
    return {
      accountId: String(client.accountId),
      environment: client.environment === 'live' ? 'live' : 'practice',
      baseUrl: client.baseUrl,
      apiKey: client.apiKey,
      get: (path) => client.get(path),
      put: (path, body) => client.put(path, body),
      isDefault: false,
    };
  }

  const headers = oandaHeaders();
  const authorization = String(headers.Authorization || '');
  const apiKey = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!apiKey) throw new Error('OANDA_API_KEY is not set — immediate partial stream unavailable');
  return {
    accountId: getAccountId(),
    environment: getEnvironment(),
    baseUrl: getOandaBaseUrl(),
    apiKey,
    get: (path) => oandaGet(path),
    put: (path, body) => oandaPut(path, body),
    isDefault: true,
  };
}

function accountKey(context) {
  return `${context.environment}:${context.accountId}`;
}

function instrumentSignature(account) {
  return [...new Set([...account.trades.values()].map((trade) => trade.instrument))]
    .filter(Boolean)
    .sort()
    .join(',');
}

function getOrCreateAccount(client) {
  const context = contextFromClient(client);
  const key = accountKey(context);
  let account = accounts.get(key);
  if (!account) {
    account = {
      key,
      ...context,
      trades: new Map(),
      generation: 0,
      controller: null,
      connected: false,
      streamInstruments: '',
      lastPriceAt: null,
      lastError: null,
    };
    accounts.set(key, account);
  } else {
    // Refresh credentials/context on every authenticated call so token rotation
    // does not require a process restart.
    account.environment = context.environment;
    account.baseUrl = context.baseUrl;
    account.apiKey = context.apiKey;
    account.get = context.get;
    account.put = context.put;
    account.isDefault = context.isDefault;
  }
  return account;
}

function stopAccountIfEmpty(account) {
  if (account.trades.size > 0) return false;
  account.generation += 1;
  account.controller?.abort();
  account.controller = null;
  account.connected = false;
  accounts.delete(account.key);
  return true;
}

function restartStream(account, reason = 'subscription_change') {
  if (stopAccountIfEmpty(account)) return;
  account.generation += 1;
  const generation = account.generation;
  account.controller?.abort();
  account.controller = null;
  account.connected = false;
  account.streamInstruments = instrumentSignature(account);
  console.log('[OANDA_PARTIAL_STREAM] restarting', {
    accountId: account.accountId,
    instruments: account.streamInstruments,
    reason,
  });
  queueMicrotask(() => {
    runPriceStream(account, generation).catch((err) => {
      console.error('[OANDA_PARTIAL_STREAM] fatal stream loop error:', err?.message || err);
    });
  });
}

function upsertTrade(account, trade = {}) {
  const tradeId = String(trade.tradeId ?? trade.id ?? '').trim();
  const instrument = normalizedInstrument(trade.instrument);
  const currentUnits = Number(trade.currentUnits);
  const entryPrice = Number(trade.entryPrice ?? trade.price);
  const initialUnits = Number(trade.initialUnits ?? trade.currentUnits);
  if (!tradeId || !instrument || !Number.isFinite(currentUnits) || currentUnits === 0 || !Number.isFinite(entryPrice)) {
    return null;
  }

  const previous = account.trades.get(tradeId);
  const alreadyReduced = brokerTradeAlreadyReduced(initialUnits, currentUnits);
  const next = {
    tradeId,
    instrument,
    entryPrice,
    initialUnits: Number.isFinite(Number(previous?.initialUnits))
      ? Number(previous.initialUnits)
      : initialUnits,
    currentUnits,
    partialTaken: previous?.partialTaken === true || alreadyReduced,
    partialInFlight: previous?.partialInFlight === true,
    maxProfitPips: Number(previous?.maxProfitPips || 0),
    lastPartialAt: previous?.lastPartialAt ?? null,
    lastError: previous?.lastError ?? null,
  };
  account.trades.set(tradeId, next);
  return next;
}

/** Register a newly-filled trade immediately; no open-trade polling is required. */
export function registerImmediatePartialTrade({
  tradeId,
  instrument,
  entryPrice,
  currentUnits,
  initialUnits = currentUnits,
  client = null,
} = {}) {
  let account;
  try {
    account = getOrCreateAccount(client);
  } catch (err) {
    console.error('[OANDA_PARTIAL_STREAM] registration failed:', err?.message || err);
    return { registered: false, reason: err?.message || String(err) };
  }

  const before = instrumentSignature(account);
  const state = upsertTrade(account, {
    tradeId,
    instrument,
    entryPrice,
    currentUnits,
    initialUnits,
  });
  if (!state) return { registered: false, reason: 'invalid_trade_registration' };
  const after = instrumentSignature(account);
  if (!account.controller || before !== after) restartStream(account, 'trade_registered');
  return {
    registered: true,
    accountId: account.accountId,
    tradeId: state.tradeId,
    partialTaken: state.partialTaken,
    triggerPips: IMMEDIATE_PARTIAL_TRIGGER_PIPS,
  };
}

/**
 * Reconcile registered stream trades from a broker open-trade snapshot. This is
 * a recovery/fail-safe path; the +15 trigger itself remains event-driven.
 */
export function syncImmediatePartialTrades(openTrades = [], { client = null } = {}) {
  let account;
  try {
    account = getOrCreateAccount(client);
  } catch (err) {
    console.error('[OANDA_PARTIAL_STREAM] sync failed:', err?.message || err);
    return { synced: false, reason: err?.message || String(err) };
  }

  const before = instrumentSignature(account);
  const openIds = new Set();
  for (const trade of Array.isArray(openTrades) ? openTrades : []) {
    const state = upsertTrade(account, trade);
    if (state) openIds.add(state.tradeId);
  }
  for (const tradeId of [...account.trades.keys()]) {
    if (!openIds.has(tradeId)) account.trades.delete(tradeId);
  }

  const after = instrumentSignature(account);
  if (!after) {
    stopAccountIfEmpty(account);
  } else if (!account.controller || before !== after) {
    restartStream(account, 'broker_trade_sync');
  }
  return { synced: true, accountId: account.accountId, trackedTrades: openIds.size };
}

export function isImmediatePartialTaken({ accountId, tradeId } = {}) {
  const id = String(tradeId || '');
  const account = [...accounts.values()].find((item) => item.accountId === String(accountId || ''));
  return account?.trades.get(id)?.partialTaken === true;
}

export function markImmediatePartialTaken({ accountId, tradeId, currentUnits = null } = {}) {
  const id = String(tradeId || '');
  const account = [...accounts.values()].find((item) => item.accountId === String(accountId || ''));
  const state = account?.trades.get(id);
  if (!state) return false;
  state.partialTaken = true;
  state.partialInFlight = false;
  if (Number.isFinite(Number(currentUnits))) state.currentUnits = Number(currentUnits);
  state.lastPartialAt = state.lastPartialAt || new Date().toISOString();
  return true;
}

async function submitImmediatePartial(account, state, observedProfitPips) {
  if (state.partialTaken || state.partialInFlight) return;
  state.partialInFlight = true;
  try {
    // Confirm the trade still exists and has not already been reduced by another
    // protection path before sending the close request.
    const response = await account.get(`/v3/accounts/${account.accountId}/trades/${state.tradeId}`);
    const brokerTrade = response?.trade;
    if (!brokerTrade) throw new Error('trade snapshot missing from OANDA response');

    const currentUnits = Number(brokerTrade.currentUnits);
    const initialUnits = Number(brokerTrade.initialUnits ?? state.initialUnits);
    if (!Number.isFinite(currentUnits) || currentUnits === 0) {
      account.trades.delete(state.tradeId);
      restartStream(account, 'trade_no_longer_open');
      return;
    }

    state.currentUnits = currentUnits;
    if (brokerTradeAlreadyReduced(initialUnits, currentUnits)) {
      state.partialTaken = true;
      state.lastPartialAt = state.lastPartialAt || new Date().toISOString();
      console.log('[OANDA_PARTIAL_STREAM_50] broker already reduced — suppressing duplicate', {
        accountId: account.accountId,
        tradeId: state.tradeId,
        instrument: state.instrument,
        initialUnits: Math.abs(initialUnits),
        currentUnits: Math.abs(currentUnits),
      });
      return;
    }

    const unitsToClose = partialUnitsForImmediateClose(currentUnits);
    if (unitsToClose == null) {
      state.partialTaken = true;
      state.lastPartialAt = new Date().toISOString();
      console.log('[OANDA_PARTIAL_STREAM_50] skipped — position too small to split', {
        accountId: account.accountId,
        tradeId: state.tradeId,
        totalUnits: Math.abs(currentUnits),
      });
      return;
    }

    await account.put(
      `/v3/accounts/${account.accountId}/trades/${state.tradeId}/close`,
      { units: String(unitsToClose) },
    );

    const sign = currentUnits > 0 ? 1 : -1;
    state.currentUnits = sign * (Math.abs(currentUnits) - unitsToClose);
    state.partialTaken = true;
    state.lastPartialAt = new Date().toISOString();
    state.lastError = null;
    console.log('[OANDA_PARTIAL_STREAM_50] immediate partial executed', {
      accountId: account.accountId,
      tradeId: state.tradeId,
      instrument: state.instrument,
      direction: currentUnits > 0 ? 'LONG' : 'SHORT',
      triggerPips: IMMEDIATE_PARTIAL_TRIGGER_PIPS,
      observedProfitPips: +Number(observedProfitPips).toFixed(2),
      closedUnits: unitsToClose,
      runnerUnits: Math.abs(state.currentUnits),
      source: 'oanda_pricing_stream',
    });
  } catch (err) {
    state.lastError = err?.message || String(err);
    if (/\[404\]|NO_SUCH_TRADE|does not exist/i.test(state.lastError)) {
      account.trades.delete(state.tradeId);
      restartStream(account, 'trade_closed_during_trigger');
      return;
    }
    console.error('[OANDA_PARTIAL_STREAM_50] immediate partial failed:', {
      accountId: account.accountId,
      tradeId: state.tradeId,
      instrument: state.instrument,
      error: state.lastError,
    });
  } finally {
    state.partialInFlight = false;
  }
}

async function handlePrice(account, message) {
  const instrument = normalizedInstrument(message?.instrument);
  if (!instrument) return;
  const bid = Number(message?.bids?.[0]?.price ?? message?.closeoutBid);
  const ask = Number(message?.asks?.[0]?.price ?? message?.closeoutAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return;
  account.lastPriceAt = message?.time || new Date().toISOString();

  const candidates = [...account.trades.values()].filter((trade) => trade.instrument === instrument);
  for (const state of candidates) {
    if (state.partialTaken || state.partialInFlight) continue;
    const profitPips = profitPipsForImmediatePartial({
      instrument,
      entryPrice: state.entryPrice,
      currentUnits: state.currentUnits,
      bid,
      ask,
    });
    if (!Number.isFinite(profitPips)) continue;
    if (profitPips > state.maxProfitPips) state.maxProfitPips = profitPips;
    if (profitPips >= IMMEDIATE_PARTIAL_TRIGGER_PIPS) {
      // Do not await this before reading the next stream message; partialInFlight
      // is set synchronously inside submitImmediatePartial, preventing duplicates.
      void submitImmediatePartial(account, state, profitPips);
    }
  }
}

async function runPriceStream(account, generation) {
  while (accounts.get(account.key) === account && account.generation === generation && account.trades.size > 0) {
    const instruments = instrumentSignature(account);
    if (!instruments) return;
    const controller = new AbortController();
    account.controller = controller;
    const base = streamBaseUrl(account.baseUrl, account.environment);
    const url = `${base}/v3/accounts/${encodeURIComponent(account.accountId)}/pricing/stream?instruments=${encodeURIComponent(instruments)}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${account.apiKey}`,
          'Accept-Datetime-Format': 'UNIX',
        },
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new Error(`OANDA pricing stream [${response.status}]: ${detail || 'empty response'}`);
      }

      account.connected = true;
      account.lastError = null;
      console.log('[OANDA_PARTIAL_STREAM] connected', {
        accountId: account.accountId,
        environment: account.environment,
        instruments,
        triggerPips: IMMEDIATE_PARTIAL_TRIGGER_PIPS,
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (account.generation === generation) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
          const raw = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!raw) continue;
          let message;
          try { message = JSON.parse(raw); } catch { continue; }
          if (message?.type === 'PRICE') await handlePrice(account, message);
        }
      }
    } catch (err) {
      if (err?.name !== 'AbortError') {
        account.lastError = err?.message || String(err);
        console.error('[OANDA_PARTIAL_STREAM] disconnected:', {
          accountId: account.accountId,
          instruments,
          error: account.lastError,
        });
      }
    } finally {
      if (account.controller === controller) account.controller = null;
      account.connected = false;
    }

    if (account.generation !== generation || account.trades.size === 0) return;
    await sleep(RECONNECT_DELAY_MS);
  }
}

export function getImmediatePartialStatus() {
  return [...accounts.values()].map((account) => ({
    accountId: account.accountId,
    environment: account.environment,
    connected: account.connected,
    instruments: instrumentSignature(account).split(',').filter(Boolean),
    lastPriceAt: account.lastPriceAt,
    lastError: account.lastError,
    trades: [...account.trades.values()].map((trade) => ({
      tradeId: trade.tradeId,
      instrument: trade.instrument,
      partialTaken: trade.partialTaken,
      partialInFlight: trade.partialInFlight,
      maxProfitPips: +Number(trade.maxProfitPips || 0).toFixed(2),
      lastPartialAt: trade.lastPartialAt,
      lastError: trade.lastError,
    })),
  }));
}

export function __resetImmediatePartialManagerForTests() {
  for (const account of accounts.values()) account.controller?.abort();
  accounts.clear();
}
