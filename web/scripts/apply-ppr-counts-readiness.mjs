import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');

function update(relativePath, transform) {
  const filePath = path.resolve(webRoot, relativePath);
  const original = fs.readFileSync(filePath, 'utf8');
  const next = transform(original);
  fs.writeFileSync(filePath, next);
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`PPR count/readiness marker missing: ${label}`);
  return source.replace(oldText, newText);
}

update('lib/scannerEngine.js', (input) => {
  let source = input;
  const oldBlock = `  const meta = object(raw.meta);

  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    scanner: 'ppr_independent',
    calculationSource: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    watchlist: ['GBP_JPY', 'EUR_GBP', 'GBP_USD'],
    qualified,
    watchCandidates,
    rejected,
    meta: {
      ...meta,
      scanner: 'ppr_independent',
      calculationSource: 'independent_ppr_raw_market_data',
      pairsScanned: numberOrNull(meta.pairsScanned) ?? qualified.length + watchCandidates.length + rejected.length,
      managementCutoffEt: text(meta.managementCutoffEt, '10:00'),
      afterCutoff: text(meta.afterCutoff, 'manual_only'),
      legacyScannerUsed: false,
      v3LogicUsed: false,
      ictLogicUsed: false,
    },
  };`;
  const newBlock = `  const meta = object(raw.meta);
  const qualifiedCount = qualified.length;
  const watchCount = watchCandidates.length;
  const rejectedCount = rejected.length;
  const accountedFor = qualifiedCount + watchCount + rejectedCount;
  const pairsScanned = numberOrNull(meta.pairsScanned) ?? accountedFor;
  const countInvariantOk = pairsScanned === accountedFor;

  return {
    engine: 'ppr',
    architecture: 'independent_ppr_raw_market_data',
    scanner: 'ppr_independent',
    calculationSource: 'independent_ppr_raw_market_data',
    legacyScannerUsed: false,
    v3LogicUsed: false,
    ictLogicUsed: false,
    watchlist: ['GBP_JPY', 'EUR_GBP', 'GBP_USD'],
    qualified,
    watchCandidates,
    rejected,
    meta: {
      ...meta,
      scanner: 'ppr_independent',
      calculationSource: 'independent_ppr_raw_market_data',
      pairsScanned,
      qualifiedCount,
      watchCount,
      rejectedCount,
      accountedFor,
      countInvariantOk,
      minConfidence: numberOrNull(meta.minConfidence) ?? 80,
      minRR: numberOrNull(meta.minRR) ?? 1.5,
      managementCutoffEt: text(meta.managementCutoffEt, '10:00'),
      afterCutoff: text(meta.afterCutoff, 'manual_only'),
      legacyScannerUsed: false,
      v3LogicUsed: false,
      ictLogicUsed: false,
    },
  };`;
  source = replaceOnce(source, oldBlock, newBlock, 'normalized PPR count invariant');
  for (const marker of ['qualifiedCount', 'watchCount', 'rejectedCount', 'accountedFor', 'countInvariantOk']) {
    if (!source.includes(marker)) throw new Error(`PPR normalized counts incomplete: ${marker}`);
  }
  return source;
});

update('components/scanner-status-card.tsx', (input) => {
  let source = input;
  source = replaceOnce(
    source,
    "  const meta = scan?.meta;",
    "  const meta = scan?.meta;\n" +
      "  const nativeCounts = {\n" +
      "    scanned: Number((meta as any)?.pairsScanned ?? qualified.length + nativeWatchCandidates.length + rejected.length),\n" +
      "    qualified: Number((meta as any)?.qualifiedCount ?? qualified.length),\n" +
      "    watching: Number((meta as any)?.watchCount ?? nativeWatchCandidates.length),\n" +
      "    rejected: Number((meta as any)?.rejectedCount ?? rejected.length),\n" +
      "    accounted: Number((meta as any)?.accountedFor ?? qualified.length + nativeWatchCandidates.length + rejected.length),\n" +
      "    invariantOk: (meta as any)?.countInvariantOk !== false,\n" +
      "  };\n" +
      "  const pprReadiness = selectedEngine === 'ppr' ? (meta as any)?.executionReadiness : null;\n" +
      "  const pprAutoAiLabel = !pprReadiness\n" +
      "    ? 'UNKNOWN'\n" +
      "    : pprReadiness.liveReady\n" +
      "      ? 'LIVE READY'\n" +
      "      : pprReadiness.orderSubmissionReady\n" +
      "        ? 'PRACTICE READY'\n" +
      "        : 'BLOCKED';",
    'dashboard native counts/readiness derived state',
  );

  source = replaceOnce(
    source,
    "            <StatChip label=\"Qualified\" value={String(qualified.length)} tone=\"good\" />\n            <StatChip label=\"Rejected\" value={String(rejected.length)} />\n            <StatChip label=\"Active scanner\" value={selectedEngine.toUpperCase()} tone=\"good\" />",
    "            <StatChip label=\"Qualified\" value={String(selectedEngine === 'ppr' ? nativeCounts.qualified : qualified.length)} tone=\"good\" />\n" +
      "            {selectedEngine === 'ppr' && <StatChip label=\"Watching\" value={String(nativeCounts.watching)} />}\n" +
      "            <StatChip label=\"Rejected\" value={String(selectedEngine === 'ppr' ? nativeCounts.rejected : rejected.length)} />\n" +
      "            <StatChip label=\"Active scanner\" value={selectedEngine.toUpperCase()} tone=\"good\" />\n" +
      "            {selectedEngine === 'ppr' && (\n" +
      "              <StatChip label=\"Auto AI\" value={pprAutoAiLabel} tone={pprReadiness?.liveReady ? 'good' : 'bad'} />\n" +
      "            )}\n" +
      "            {selectedEngine === 'ppr' && (\n" +
      "              <StatChip label=\"Count check\" value={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'OK' : 'MISMATCH'} tone={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'good' : 'bad'} />\n" +
      "            )}",
    'dashboard PPR count/readiness chips',
  );

  for (const marker of ['pprAutoAiLabel', 'label="Watching"', 'label="Count check"', "'LIVE READY'"]) {
    if (!source.includes(marker)) throw new Error(`PPR dashboard readiness incomplete: ${marker}`);
  }
  return source;
});

console.log('PPR dashboard counts and live-execution readiness applied.');
