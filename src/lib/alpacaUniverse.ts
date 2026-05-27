// ── Alpaca Market Universe Loader ─────────────────────────────────────────────
// LIVE market universe loader for Signal Stack.
//
// Fetches the full list of active tradable US equities from the backend
// Alpaca LIVE assets route.
//
// Features:
// - Live-only market universe
// - Safe rotating batches
// - Automatic fallback universe
// - Cached universe loading
// - Batch rotation tracking
// - Full-market scan support

import { ALPACA_API_BASE } from './apiBase';

// ── Fallback Universe ─────────────────────────────────────────────────────────

export const FALLBACK_UNIVERSE: string[] = [
  "NVDA","AAPL","MSFT","GOOGL","GOOG","META","AMZN","TSLA","AMD","INTC",
  "QCOM","AVGO","MU","SMCI","ARM","TXN","AMAT","LRCX","KLAC","MRVL",

  "CRM","NOW","SNOW","PLTR","UBER","LYFT","SHOP","DDOG","ZS","CRWD",
  "NET","OKTA","TWLO","MDB","GTLB","HUBS","BILL","VEEV","WDAY","TEAM",

  "JPM","BAC","GS","MS","C","WFC","BLK","SCHW","AXP","COF",
  "V","MA","PYPL","SQ","SOFI","HOOD","NU","AFRM","LC",

  "SPY","QQQ","IWM","DIA","XLK","XLF","XLE","XLV","XLI","XLY",
  "ARKK","SOXS","SOXL","TQQQ","SPXL","UVXY","VXX",

  "LLY","UNH","JNJ","ABT","TMO","DHR","ISRG","DXCM","IDXX","ILMN",
  "MRNA","BNTX","REGN","BIIB","GILD","AMGN","VRTX",

  "XOM","CVX","COP","OXY","SLB","HAL","MPC","VLO","PSX",

  "COST","WMT","HD","LOW","TGT","NKE","SBUX","MCD","CMG",
  "LULU","RH","W","ETSY","EBAY",

  "F","GM","RIVN","LCID","NIO","XPEV","LI",

  "NFLX","DIS","PARA","WBD","SPOT","RBLX","EA","TTWO",

  "AMT","PLD","EQIX","CCI","SPG",

  "BA","LMT","RTX","GE","CAT","DE","UPS","FDX","DAL","AAL","UAL",

  "MCHP","ADI","NXPI","STM","ON","WOLF","SWKS",
];

// ── Types ─────────────────────────────────────────────────────────────────────

export type UniverseSource = 'alpaca' | 'fallback';

export type BatchState = {
  symbols: string[];
  totalSymbols: number;
  scannedSymbolsToday: number;
  currentBatchStart: number;
  currentBatchEnd: number;
  qualifiedSignals: number;
  lastScanTime: string;
  dataSource: UniverseSource;
  marketScanMode: 'full-market';
  warning?: string;
};

// ── Internal State ────────────────────────────────────────────────────────────

const BATCH_SIZE = 5000;

let _universe: string[] = [];
let _source: UniverseSource = 'fallback';
let _loadedAt: number | null = null;

let _batchCursor = 0;
let _scannedToday = 0;
let _lastScanTime = '';

const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniqueSymbols(symbols: string[]): string[] {
  return [...new Set(
    symbols
      .map(s => String(s).trim().toUpperCase())
      .filter(Boolean)
  )];
}

function isCacheFresh(): boolean {
  return Boolean(
    _loadedAt &&
    Date.now() - _loadedAt < CACHE_TTL_MS &&
    _universe.length > 0
  );
}

function getTimeString(): string {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function getTodayKey(): string {
  return new Date().toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
  });
}

// ── Daily Reset Tracking ──────────────────────────────────────────────────────

let _lastResetDate = getTodayKey();

function resetIfNeeded() {
  const today = getTodayKey();

  if (_lastResetDate !== today) {
    _lastResetDate = today;
    _scannedToday = 0;
    _batchCursor = 0;
  }
}

// ── Universe Loader ───────────────────────────────────────────────────────────

async function loadUniverse(): Promise<{
  symbols: string[];
  source: UniverseSource;
  warning?: string;
}> {

  resetIfNeeded();

  // Use cache if fresh
  if (isCacheFresh()) {
    return {
      symbols: _universe,
      source: _source,
    };
  }

  try {
    const response = await fetch(
      `${ALPACA_API_BASE}/api/alpaca/assets`,
      {
        headers: {
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as {
      symbols?: string[];
      total?: number;
      source?: string;
      environment?: string;
    };

    if (!Array.isArray(data.symbols)) {
      throw new Error('Invalid assets payload');
    }

    const cleanedSymbols = uniqueSymbols(data.symbols);

    if (cleanedSymbols.length === 0) {
      throw new Error('Empty symbols list from Alpaca');
    }

    _universe = cleanedSymbols;
    _source = 'alpaca';
    _loadedAt = Date.now();

    console.log(
      `[alpacaUniverse] Loaded LIVE market universe: ${cleanedSymbols.length} symbols`
    );
    console.log("Universe size:", cleanedSymbols.length);

    return {
      symbols: _universe,
      source: 'alpaca',
    };

  } catch (err) {

    console.warn(
      '[alpacaUniverse] Falling back to demo universe:',
      err
    );

    _universe = uniqueSymbols(FALLBACK_UNIVERSE);
    _source = 'fallback';
    _loadedAt = Date.now();
    console.log("Universe size:", _universe.length, "(fallback)");

    return {
      symbols: _universe,
      source: 'fallback',
      warning: 'LIVE Alpaca universe unavailable — fallback universe active',
    };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const alpacaUniverse = {

  /**
   * Returns the next rotating batch of symbols.
   * Used by Signal Engine scanning cycles.
   */
  async nextBatch(): Promise<{
    batch: string[];
    state: BatchState;
  }> {

    const { symbols, source, warning } = await loadUniverse();

    if (!symbols.length) {
      return {
        batch: [],
        state: {
          symbols: [],
          totalSymbols: 0,
          scannedSymbolsToday: 0,
          currentBatchStart: 0,
          currentBatchEnd: 0,
          qualifiedSignals: 0,
          lastScanTime: getTimeString(),
          dataSource: source,
          marketScanMode: 'full-market',
          warning: 'No symbols available',
        },
      };
    }

    // Wrap cursor if needed
    if (_batchCursor >= symbols.length) {
      _batchCursor = 0;
    }

    const start = _batchCursor;
    const end = Math.min(start + BATCH_SIZE, symbols.length);

    const batch = symbols.slice(start, end);

    _batchCursor = end >= symbols.length ? 0 : end;

    _scannedToday += batch.length;
    _lastScanTime = getTimeString();

    const state: BatchState = {
      symbols,
      totalSymbols: symbols.length,
      scannedSymbolsToday: _scannedToday,
      currentBatchStart: start + 1,
      currentBatchEnd: end,
      qualifiedSignals: 0,
      lastScanTime: _lastScanTime,
      dataSource: source,
      marketScanMode: 'full-market',
      warning,
    };

    return {
      batch,
      state,
    };
  },

  /**
   * Force universe reload on next cycle.
   */
  invalidateCache() {
    _loadedAt = null;
  },

  /**
   * Reset batch state manually.
   */
  resetDaily() {
    _scannedToday = 0;
    _batchCursor = 0;
    _lastResetDate = getTodayKey();
  },

  /**
   * Returns currently loaded universe.
   */
  get universe(): string[] {
    return _universe;
  },

  /**
   * Returns current data source.
   */
  get source(): UniverseSource {
    return _source;
  },

  /**
   * Returns loaded symbol count.
   */
  get totalSymbols(): number {
    return _universe.length;
  },

  /**
   * Returns current batch size.
   */
  get batchSize(): number {
    return BATCH_SIZE;
  },

  /**
   * Returns scan progress metadata.
   */
  get status() {
    return {
      source: _source,
      totalSymbols: _universe.length,
      scannedToday: _scannedToday,
      currentCursor: _batchCursor,
      lastScanTime: _lastScanTime,
      cacheLoaded: Boolean(_loadedAt),
      cacheAgeMs: _loadedAt ? Date.now() - _loadedAt : null,
      marketScanMode: 'full-market',
    };
  },
};