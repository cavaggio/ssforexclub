import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function patchFile(relativePath, transform, markers = []) {
  const path = resolve(ROOT, relativePath);
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  const missing = markers.filter((marker) => !after.includes(marker));
  if (missing.length) throw new Error(`${relativePath} missing signal-forensics markers: ${missing.join(', ')}`);
  if (after !== before) writeFileSync(path, after, 'utf8');
  console.log(`[SIGNAL_FORENSICS] verified ${relativePath}${after !== before ? ' (patched)' : ''}`);
}

function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`${label}: source marker not found`);
  return source.replace(before, after);
}

function replaceSection(source, startMarker, endMarker, replacement, label) {
  if (source.includes(replacement)) return source;
  const start = source.indexOf(startMarker);
  const end = start >= 0 ? source.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) throw new Error(`${label}: section markers not found`);
  return `${source.slice(0, start)}${replacement}${source.slice(end)}`;
}

patchFile('server/index.js', (source) => {
  let out = source;
  out = replaceOnce(
    out,
    "import { analyzeICTPairs, ICT_MODE } from './ictEngine.js';",
    "import { analyzeICTPairs, ICT_MODE, isIctExecutionEnabled } from './ictEngine.js';",
    'ICT boot import',
  );
  out = replaceOnce(
    out,
    `  // ICT engine is shadow-only analysis (never trades); 'off' disables the tab's data.\n  const ictExecutionEnabled =\n    process.env.ICT_ENGINE_MODE === 'live' &&\n    process.env.ICT_AUTO_TRADE_ENABLED === 'true';`,
    `  // Use the scanner/executor's authoritative gate so boot diagnostics cannot disagree.\n  const ictExecutionEnabled = isIctExecutionEnabled();`,
    'ICT boot diagnostic',
  );
  return out;
}, ["ICT_MODE, isIctExecutionEnabled", 'const ictExecutionEnabled = isIctExecutionEnabled();']);

const watchStateSource = `function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rejectionReasonsOf(item) {
  return Array.isArray(item?.rejectionReasons)
    ? item.rejectionReasons.map((reason) => String(reason || ''))
    : [];
}

function isWaitableTriggerReason(reason) {
  const text = String(reason || '').toLowerCase();
  return text.includes('no 5m entry-timing trigger') ||
    text.includes('no fresh 5m impulse/structure trigger');
}

function hasBlockingHardReject(item) {
  return rejectionReasonsOf(item).some((reason) =>
    /^hard gate:/i.test(reason) && !isWaitableTriggerReason(reason)
  );
}

function hasLateOrInvalidTiming(item) {
  return rejectionReasonsOf(item).some((reason) => {
    const text = reason.toLowerCase();
    return text.includes('late market entry') ||
      text.includes('outside the valid ict entry zone') ||
      text.includes('nearest natural liquidity target does not provide') ||
      text.includes('executable r:r') ||
      text.includes('news block');
  });
}

function hasConcreteIctContext(item) {
  const labels = Array.isArray(item?.conceptsDetected) ? item.conceptsDetected : [];
  return labels.some((label) =>
    /^(liquidity sweep|displacement|mss|bos|choch|.* fvg|.* ob|ote|killzone:|daily\+4h aligned)/i.test(String(label || ''))
  );
}

function hasExecutableGeometry(item, minimumRR) {
  const entry = finiteNumber(item?.entry);
  const stop = finiteNumber(item?.stopLoss);
  const target = finiteNumber(item?.target1);
  const rr = finiteNumber(item?.rr);
  const bias = String(item?.ictBias || item?.direction || '').toLowerCase();
  const bullish = bias === 'bullish' || bias === 'long' || item?.signal === 'buy';
  const bearish = bias === 'bearish' || bias === 'short' || item?.signal === 'sell';
  if (![entry, stop, target, rr].every(Number.isFinite)) return false;
  if (rr < minimumRR || item?.targetAdjustedToMinRR === true) return false;
  if (bullish) return stop < entry && target > entry;
  if (bearish) return stop > entry && target < entry;
  return false;
}

export function maskAccountForLog(id) {
  const value = String(id || '');
  const parts = value.split('-').filter(Boolean);
  if (parts.length >= 3) {
    const core = parts.at(-2) || '';
    return parts[0] + '…' + core.slice(-4) + '…' + (parts.at(-1) || '');
  }
  return value.length > 6 ? value.slice(0, 3) + '…' + value.slice(-4) : '***';
}

const maskAccount = maskAccountForLog;

export function buildIctWatchState(analyses = [], minConfidence = 93, minRR = 1.5) {
  const nearQualifiedPairs = new Set();
  const hotPairs = new Set();
  const lateEntryPairs = new Set();
  const cfg = { minConfidence: Number(minConfidence), minRR: Number(minRR) };
  const nearFloor = Math.max(60, cfg.minConfidence - 15);

  for (const item of analyses) {
    const pair = item?.pair;
    if (!pair) continue;
    if (isIctAutoQualified(item, cfg)) {
      hotPairs.add(pair);
      continue;
    }
    if (hasLateOrInvalidTiming(item)) {
      lateEntryPairs.add(pair);
      continue;
    }

    const confidence = finiteNumber(item?.confidence) ?? 0;
    const bias = String(item?.ictBias || item?.direction || '').toLowerCase();
    const directionalBias = ['bullish', 'bearish', 'long', 'short'].includes(bias);
    const waitingForTrigger = rejectionReasonsOf(item).some(isWaitableTriggerReason);
    const triggerAge = finiteNumber(item?.triggerAgeBars);
    const freshTrigger = item?.freshImpulse === true || (triggerAge != null && triggerAge <= 1);

    if (
      directionalBias &&
      !hasBlockingHardReject(item) &&
      hasConcreteIctContext(item) &&
      hasExecutableGeometry(item, cfg.minRR) &&
      confidence >= nearFloor &&
      (freshTrigger || waitingForTrigger)
    ) nearQualifiedPairs.add(pair);
  }

  for (const pair of lateEntryPairs) {
    nearQualifiedPairs.delete(pair);
    hotPairs.delete(pair);
  }

  return {
    nearQualifiedPairs: [...nearQualifiedPairs],
    hotPairs: [...hotPairs],
    lateEntryPairs: [...lateEntryPairs],
  };
}

`;

patchFile('server/ictAutoTrade.js', (source) => {
  let out = replaceSection(
    source,
    'function maskAccount(id) {',
    'export function isIctAutoQualified',
    watchStateSource,
    'ICT watch-state section',
  );
  out = replaceOnce(
    out,
    'const watchState = buildIctWatchState(analyses, cfg.minConfidence);',
    'const watchState = buildIctWatchState(analyses, cfg.minConfidence, cfg.minRR);',
    'ICT watch-state invocation',
  );
  return out;
}, [
  'export function maskAccountForLog',
  'export function buildIctWatchState',
  'hasBlockingHardReject(item)',
  'hasExecutableGeometry(item, cfg.minRR)',
  'buildIctWatchState(analyses, cfg.minConfidence, cfg.minRR)',
]);

const schedulerHelper = `export function buildOandaSyncDiagnosticLines(text, tag = '[OANDA_TX_SYNC]') {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const lines = [];
  for (const result of Array.isArray(data?.results) ? data.results : []) {
    const sync = result?.sync;
    if (!sync || typeof sync !== 'object') continue;
    const user = String(result?.user || '***');
    const account = String(sync.accountLabel || '***');
    lines.push(
      tag + '[ACCOUNT] user=' + user + ' account=' + account + ' env=' + (sync.environment || 'unknown') +
      ' fetched=' + (sync.fetched ?? 0) + ' closeEvents=' + (sync.closeEvents ?? 0) +
      ' logged=' + (sync.logged ?? 0) + ' failed=' + (sync.failed ?? 0) +
      ' released=' + (sync.reservationsReleased ?? 0) + ' lossLocked=' + (sync.reservationsLossLocked ?? 0)
    );
    for (const close of Array.isArray(sync.closeDetails) ? sync.closeDetails : []) {
      lines.push(
        tag + '[CLOSE] user=' + user + ' account=' + account + ' tradeId=' + (close.tradeId ?? 'unknown') +
        ' pair=' + (close.instrument ?? 'unknown') + ' side=' + (close.side ?? 'unknown') +
        ' reason=' + (close.closeReason ?? close.reason ?? 'unknown') + ' pnl=' + (close.realizedPL ?? 'unknown') +
        ' exit=' + (close.price ?? 'unknown') + ' units=' + (close.unitsClosed ?? 'unknown') +
        ' reservation=' + (close.reservationState ?? 'none') + ' logged=' + (close.logged === true)
      );
    }
  }
  return lines;
}

`;

patchFile('server/ictAutoScheduler.js', (source) => {
  let out = source;
  if (!out.includes('export function buildOandaSyncDiagnosticLines')) {
    const marker = 'async function post(nextUrl, secret, path, body, tag) {';
    const index = out.indexOf(marker);
    if (index < 0) throw new Error('scheduler post marker not found');
    out = `${out.slice(0, index)}${schedulerHelper}${out.slice(index)}`;
  }
  return replaceOnce(
    out,
    '    console.log(`${tag} status=${response.status} ${text.slice(0, 300)}`);\n    return { ok: response.ok, status: response.status, body: text };',
    "    console.log(`${tag} status=${response.status} ${text.slice(0, 300)}`);\n    if (tag.startsWith('[OANDA_TX_SYNC]')) {\n      for (const line of buildOandaSyncDiagnosticLines(text, tag)) console.log(line);\n    }\n    return { ok: response.ok, status: response.status, body: text };",
    'OANDA transaction diagnostics',
  );
}, [
  'export function buildOandaSyncDiagnosticLines',
  "if (tag.startsWith('[OANDA_TX_SYNC]'))",
  "tag + '[CLOSE] user='",
]);

const diagnosticTypes = `type CloseDiagnostic = {
  transactionId: string;
  tradeId: string | null;
  instrument: string | null;
  side: 'long' | 'short' | null;
  reason: string;
  closeReason: string;
  time: string | null;
  price: number | null;
  unitsClosed: number | null;
  realizedPL: number | null;
  fullyClosed: boolean;
  reservationState: 'released' | 'loss_locked' | null;
  logged: boolean;
};

export function maskBrokerAccountForLog(id: string): string {
  const value = String(id || '');
  const parts = value.split('-').filter(Boolean);
  if (parts.length >= 3) {
    const core = parts.at(-2) || '';
    return parts[0] + '…' + core.slice(-4) + '…' + (parts.at(-1) || '');
  }
  return value.length > 6 ? value.slice(0, 3) + '…' + value.slice(-4) : '***';
}

`;

const oldReservationBlock = `        if (result.ok && event.fullyClosed && event.tradeId) {
          const reservationState = await updateExecutionReservationAfterClose({
            tradeId: event.tradeId,
            closeReason,
            fullyClosed: event.fullyClosed,
          });
          if (reservationState === 'released') reservationsReleased += 1;
          if (reservationState === 'loss_locked') reservationsLossLocked += 1;
        }`;

const newReservationBlock = `        let reservationState: 'released' | 'loss_locked' | null = null;
        if (result.ok && event.fullyClosed && event.tradeId) {
          reservationState = await updateExecutionReservationAfterClose({
            tradeId: event.tradeId,
            closeReason,
            fullyClosed: event.fullyClosed,
          });
          if (reservationState === 'released') reservationsReleased += 1;
          if (reservationState === 'loss_locked') reservationsLossLocked += 1;
        }

        const diagnostic: CloseDiagnostic = {
          transactionId: event.transactionId,
          tradeId: event.tradeId,
          instrument: event.instrument,
          side: event.side,
          reason: event.reason,
          closeReason,
          time: event.time,
          price: event.price,
          unitsClosed: event.unitsClosed,
          realizedPL: pnl,
          fullyClosed: event.fullyClosed,
          reservationState,
          logged: result.ok,
        };
        closeDetails.push(diagnostic);
        console.log(tag + ' close=' + JSON.stringify(diagnostic));`;

patchFile('web/lib/oandaTransactionSync.ts', (source) => {
  let out = source;
  if (!out.includes('type CloseDiagnostic = {')) {
    const marker = 'function numeric(value: unknown): number | null {';
    const index = out.indexOf(marker);
    if (index < 0) throw new Error('transaction sync numeric marker not found');
    out = `${out.slice(0, index)}${diagnosticTypes}${out.slice(index)}`;
  }
  out = replaceOnce(
    out,
    `  const maskedAccount =\n    args.brokerAccountId.length > 6\n      ? \`${'${args.brokerAccountId.slice(0, 3)}'}…${'${args.brokerAccountId.slice(-3)}'}\`\n      : '***';`,
    '  const maskedAccount = maskBrokerAccountForLog(args.brokerAccountId);',
    'transaction account mask',
  );
  out = replaceOnce(out, '  accountId: string;\n  environment: Env;', '  accountId: string;\n  accountLabel: string;\n  environment: Env;', 'transaction return account label');
  out = replaceOnce(out, '  lastTransactionId: string | null;\n  error?: string;', '  lastTransactionId: string | null;\n  closeDetails: CloseDiagnostic[];\n  error?: string;', 'transaction return details');
  out = replaceOnce(out, '    let reservationsLossLocked = 0;\n\n    for (const tx of transactions) {', '    let reservationsLossLocked = 0;\n    const closeDetails: CloseDiagnostic[] = [];\n\n    for (const tx of transactions) {', 'transaction detail collection');
  out = replaceOnce(out, oldReservationBlock, newReservationBlock, 'transaction close diagnostics');
  out = replaceOnce(out, '      accountId: args.brokerAccountId,\n      environment: args.environment,', '      accountId: args.brokerAccountId,\n      accountLabel: maskedAccount,\n      environment: args.environment,', 'transaction success label');
  out = replaceOnce(out, '      lastTransactionId: nextLast ?? null,\n    };', '      lastTransactionId: nextLast ?? null,\n      closeDetails,\n    };', 'transaction success details');
  out = replaceOnce(out, '      accountId: args.brokerAccountId,\n      environment: args.environment,\n      fetched: 0,', '      accountId: args.brokerAccountId,\n      accountLabel: maskedAccount,\n      environment: args.environment,\n      fetched: 0,', 'transaction failure label');
  out = replaceOnce(out, '      lastTransactionId: null,\n      error: message,', '      lastTransactionId: null,\n      closeDetails: [],\n      error: message,', 'transaction failure details');
  return out;
}, [
  'export function maskBrokerAccountForLog',
  'accountLabel: string;',
  'closeDetails: CloseDiagnostic[];',
  'const closeDetails: CloseDiagnostic[] = [];',
  "console.log(tag + ' close=' + JSON.stringify(diagnostic));",
]);

function verify(relativePath, markers) {
  const source = readFileSync(resolve(ROOT, relativePath), 'utf8');
  const missing = markers.filter((marker) => !source.includes(marker));
  if (missing.length) throw new Error(`${relativePath} signal/open-trade sync drift: ${missing.join(', ')}`);
  console.log(`[SIGNAL_FORENSICS] signal/open-trade contract verified ${relativePath}`);
}

verify('server/ictEngine.js', [
  'targetHitConfidence: confidence',
  'freshImpulse',
  'triggerAgeBars',
  'entryZoneLow',
  'targetAdjustedToMinRR',
]);
verify('server/oandaActiveTradeMonitor.js', [
  "confidenceModel: pureIctTrade ? 'ict_target_hit_lifecycle'",
  'ictProbabilitiesFromConfidence(currentConfidence)',
  'entryTpHitConfidence: historyRecord?.entryTpHitConfidence ?? null',
]);
