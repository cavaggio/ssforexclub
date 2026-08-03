import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function patchOandaExecutableQuote(source) {
  let out = source;
  const importLine = "import { selectExecutableQuote } from './oandaExecutableQuote.js';";

  if (!out.includes(importLine)) {
    const importAnchor = "import { getPipSize } from './pipMath.js';";
    if (!out.includes(importAnchor)) {
      throw new Error('[OANDA_EXECUTABLE_QUOTE] pipMath import anchor not found');
    }
    out = out.replace(importAnchor, `${importAnchor}\n${importLine}`);
  }

  const functionPattern = /function quoteMidPrice\(q\) \{[\s\S]*?\n\}\n\nfunction validateFreshProtectivePrices/;
  const replacement = `function quoteMidPrice(q) {
  const selected = selectExecutableQuote(q);
  console.log('[ICT_EXECUTION_QUOTE_RAW]', {
    instrument: q?.instrument ?? null,
    source: selected.source,
    bid: selected.bid,
    ask: selected.ask,
    closeoutBid: selected.closeoutBid,
    closeoutAsk: selected.closeoutAsk,
    spread: selected.spread ?? null,
    ok: selected.ok,
  });
  if (selected.ok) return selected;
  return {
    bid: null,
    ask: null,
    mid: null,
    spread: null,
    source: selected.source,
    closeoutBid: selected.closeoutBid,
    closeoutAsk: selected.closeoutAsk,
  };
}

function validateFreshProtectivePrices`;

  if (!out.includes("selectExecutableQuote(q)")) {
    if (!functionPattern.test(out)) {
      throw new Error('[OANDA_EXECUTABLE_QUOTE] quoteMidPrice function not found');
    }
    out = out.replace(functionPattern, replacement);
  }

  const required = [
    importLine,
    'selectExecutableQuote(q)',
    "[ICT_EXECUTION_QUOTE_RAW]",
  ];
  const missing = required.filter((marker) => !out.includes(marker));
  if (missing.length) {
    throw new Error(`[OANDA_EXECUTABLE_QUOTE] missing markers: ${missing.join(', ')}`);
  }
  if (/q\?\.closeoutBid\s*\?\?/.test(out) || /q\?\.closeoutAsk\s*\?\?/.test(out)) {
    throw new Error('[OANDA_EXECUTABLE_QUOTE] closeout prices still precede executable order-book prices');
  }
  return out;
}

export function applyOandaExecutableQuoteFix(root = DEFAULT_ROOT) {
  const path = resolve(root, 'server/ictExecution.js');
  if (!existsSync(path)) return false;
  const before = readFileSync(path, 'utf8');
  const after = patchOandaExecutableQuote(before);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[OANDA_EXECUTABLE_QUOTE] verified server/ictExecution.js${after !== before ? ' (patched)' : ''}`);
  return after !== before;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  applyOandaExecutableQuoteFix();
}
