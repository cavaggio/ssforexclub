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

function insertAfter(source, anchor, addition, label, startAt = 0) {
  if (source.includes(addition.trim())) return source;
  const index = source.indexOf(anchor, startAt);
  if (index < 0) throw new Error(`PPR count/readiness marker missing: ${label}`);
  const end = index + anchor.length;
  return source.slice(0, end) + addition + source.slice(end);
}

function replaceSmall(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`PPR count/readiness marker missing: ${label}`);
  return source.replace(oldText, newText);
}

update('lib/scannerEngine.js', (input) => {
  let source = input;
  const pprStart = source.indexOf('export function normalizePprScan');
  if (pprStart < 0) throw new Error('PPR count/readiness marker missing: normalizePprScan');

  if (!source.includes('  const qualifiedCount = qualified.length;')) {
    source = insertAfter(
      source,
      '  const meta = object(raw.meta);',
      "\n  const qualifiedCount = qualified.length;\n" +
        "  const watchCount = watchCandidates.length;\n" +
        "  const rejectedCount = rejected.length;\n" +
        "  const accountedFor = qualifiedCount + watchCount + rejectedCount;\n" +
        "  const pairsScanned = numberOrNull(meta.pairsScanned) ?? accountedFor;\n" +
        "  const countInvariantOk = pairsScanned === accountedFor;",
      'normalized PPR count declarations',
      pprStart,
    );
  }

  if (!source.includes('      qualifiedCount,\n      watchCount,\n      rejectedCount,')) {
    source = replaceSmall(
      source,
      '      pairsScanned: numberOrNull(meta.pairsScanned) ?? qualified.length + watchCandidates.length + rejected.length,',
      "      pairsScanned,\n" +
        "      qualifiedCount,\n" +
        "      watchCount,\n" +
        "      rejectedCount,\n" +
        "      accountedFor,\n" +
        "      countInvariantOk,\n" +
        "      minConfidence: numberOrNull(meta.minConfidence) ?? 75,\n" +
        "      minRR: numberOrNull(meta.minRR) ?? 1.5,",
      'normalized PPR metadata counts',
    );
  }

  for (const marker of ['qualifiedCount', 'watchCount', 'rejectedCount', 'accountedFor', 'countInvariantOk']) {
    if (!source.includes(marker)) throw new Error(`PPR normalized counts incomplete: ${marker}`);
  }
  return source;
});

update('components/scanner-status-card.tsx', (input) => {
  let source = input;
  if (!source.includes('  const pprAutoAiLabel = !pprReadiness')) {
    source = insertAfter(
      source,
      '  const meta = scan?.meta;',
      "\n  const nativeCounts = {\n" +
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
  }

  if (!source.includes('label="Watching"')) {
    source = replaceSmall(
      source,
      '            <StatChip label="Qualified" value={String(qualified.length)} tone="good" />',
      "            <StatChip label=\"Qualified\" value={String(selectedEngine === 'ppr' ? nativeCounts.qualified : qualified.length)} tone=\"good\" />\n" +
        "            {selectedEngine === 'ppr' && <StatChip label=\"Watching\" value={String(nativeCounts.watching)} />}",
      'dashboard PPR qualified/watching chips',
    );
  }

  if (!source.includes("selectedEngine === 'ppr' ? nativeCounts.rejected")) {
    source = replaceSmall(
      source,
      '            <StatChip label="Rejected" value={String(rejected.length)} />',
      "            <StatChip label=\"Rejected\" value={String(selectedEngine === 'ppr' ? nativeCounts.rejected : rejected.length)} />",
      'dashboard PPR rejected chip',
    );
  }

  if (!source.includes('label="Count check"')) {
    source = replaceSmall(
      source,
      '            <StatChip label="Active scanner" value={selectedEngine.toUpperCase()} tone="good" />',
      "            <StatChip label=\"Active scanner\" value={selectedEngine.toUpperCase()} tone=\"good\" />\n" +
        "            {selectedEngine === 'ppr' && (\n" +
        "              <StatChip label=\"Auto AI\" value={pprAutoAiLabel} tone={pprReadiness?.liveReady ? 'good' : 'bad'} />\n" +
        "            )}\n" +
        "            {selectedEngine === 'ppr' && (\n" +
        "              <StatChip label=\"Count check\" value={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'OK' : 'MISMATCH'} tone={nativeCounts.invariantOk && nativeCounts.scanned === nativeCounts.accounted ? 'good' : 'bad'} />\n" +
        "            )}",
      'dashboard PPR readiness/count-check chips',
    );
  }

  for (const marker of ['pprAutoAiLabel', 'label="Watching"', 'label="Count check"', "'LIVE READY'"]) {
    if (!source.includes(marker)) throw new Error(`PPR dashboard readiness incomplete: ${marker}`);
  }
  return source;
});

console.log('PPR dashboard counts and live-execution readiness applied.');
