import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const target = path.join(webRoot, 'components', 'scanner-status-card.tsx');

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  if (!source.includes(oldText)) throw new Error(`PPR scanner UI marker missing: ${label}`);
  return source.replace(oldText, newText);
}

let source = fs.readFileSync(target, 'utf8');

source = replaceOnce(
  source,
  "import { useCallback, useEffect, useState } from 'react';",
  "import { useCallback, useEffect, useState } from 'react';\nimport { NativeEngineScanPanel } from '@/components/native-engine-scan-panel';",
  'native panel import',
);

source = replaceOnce(
  source,
  "  isLiveTrading: boolean;\n  error?: string;",
  "  isLiveTrading: boolean;\n  selectedEngine: 'ict' | 'v3' | 'ppr';\n  error?: string;",
  'selected engine response type',
);

source = replaceOnce(
  source,
  "  const [error, setError] = useState<string | null>(null);",
  "  const [error, setError] = useState<string | null>(null);\n  const [preferredEngine, setPreferredEngine] = useState<'ict' | 'v3' | 'ppr' | null>(null);",
  'preferred engine state',
);

source = replaceOnce(
  source,
  "  const [tradeLogsFilter, setTradeLogsFilter] = useState<string>('all');\n\n  const runScan",
  "  const [tradeLogsFilter, setTradeLogsFilter] = useState<string>('all');\n\n" +
    "  useEffect(() => {\n" +
    "    const onEngineChanged = (event: Event) => {\n" +
    "      const value = (event as CustomEvent<{ engine?: unknown }>).detail?.engine;\n" +
    "      const engine = value === 'ppr' || value === 'v3' ? value : 'ict';\n" +
    "      setPreferredEngine(engine);\n" +
    "      setState(null);\n" +
    "      setError(null);\n" +
    "    };\n" +
    "    window.addEventListener('signal-stack-engine-changed', onEngineChanged);\n" +
    "    return () => window.removeEventListener('signal-stack-engine-changed', onEngineChanged);\n" +
    "  }, []);\n\n" +
    "  const runScan",
  'engine change listener',
);

source = replaceOnce(
  source,
  "          isLiveTrading: false,\n          error: raw?.error,",
  "          isLiveTrading: false,\n          selectedEngine: raw?.selectedEngine === 'ppr' || raw?.selectedEngine === 'v3' ? raw.selectedEngine : 'ict',\n          error: raw?.error,",
  'error engine attribution',
);

source = replaceOnce(
  source,
  "      setState({\n        ok: true,",
  "      const responseEngine = raw.selectedEngine === 'ppr' || raw.selectedEngine === 'v3' ? raw.selectedEngine : 'ict';\n" +
    "      setPreferredEngine(responseEngine);\n" +
    "      setState({\n        ok: true,",
  'successful engine attribution setup',
);

source = replaceOnce(
  source,
  "        isLiveTrading: !!raw.isLiveTrading,\n      });",
  "        isLiveTrading: !!raw.isLiveTrading,\n        selectedEngine: responseEngine,\n      });",
  'successful engine attribution',
);

const oldDerived = `  const scan = state?.scan;
  const qualifiedRaw = scan?.qualified ?? [];
  const rejectedRaw = scan?.rejected ?? [];

  // Universal display rule: never populate dashboard trade cards below 1.5R.
  // They are still hard-blocked server-side, but hiding them avoids treating
  // non-executable setups as actionable trade candidates.
  const qualified = qualifiedRaw.filter((sig: any) => !isSubMinRrDisplay(sig));
  // Trade execution is only offered when the scanner response confirms live
  // mode AND the call succeeded (state.ok). Anything less surfaces an inline
  // blocker on each signal card so the user knows what to fix.
  const isPaperEnv = state?.activeEnvironment === 'practice' || state?.activeEnvironment === 'paper';
  const liveExecutionEnabled = !!(state?.ok && state?.isLiveTrading);
  // Paper/practice can execute too — a successful scan means creds resolved for
  // that environment (the proxy 409s otherwise). Live still requires the live
  // gates (platform flag + live-ack), enforced upstream by the broker resolver.
  const paperExecutionEnabled = !!(state?.ok && !state?.isLiveTrading && isPaperEnv);
  const executionEnabled = liveExecutionEnabled || paperExecutionEnabled;
  const executionBlockerReason: string | null = !state?.ok
    ? 'Run a scan first to verify your broker resolution.'
    : !executionEnabled
      ? \`Active environment is "\${state.activeEnvironment ?? 'practice'}" — connect a broker for this mode (or switch to OANDA Live) to execute trades.\`
      : null;
  const rejected = rejectedRaw.filter((sig: any) => !isSubMinRrDisplay(sig));
  const meta = scan?.meta;`;

const newDerived = `  const scan = state?.scan;
  const selectedEngine = state?.selectedEngine ?? preferredEngine ?? 'v3';
  const isV3Scan = selectedEngine === 'v3';
  const qualifiedRaw = scan?.qualified ?? [];
  const rejectedRaw = scan?.rejected ?? [];
  const nativeWatchCandidates = Array.isArray((scan as any)?.watchCandidates)
    ? (scan as any).watchCandidates
    : [];

  // The executable R:R display guard applies to the legacy-shaped V3 cards.
  // Native PPR cards must retain below-floor rejection diagnostics.
  const qualified = selectedEngine === 'ppr'
    ? qualifiedRaw
    : qualifiedRaw.filter((sig: any) => !isSubMinRrDisplay(sig));
  const rejected = selectedEngine === 'ppr'
    ? rejectedRaw
    : rejectedRaw.filter((sig: any) => !isSubMinRrDisplay(sig));
  // Trade execution is only offered when the scanner response confirms live
  // mode AND the call succeeded (state.ok). Anything less surfaces an inline
  // blocker on each signal card so the user knows what to fix.
  const isPaperEnv = state?.activeEnvironment === 'practice' || state?.activeEnvironment === 'paper';
  const liveExecutionEnabled = !!(state?.ok && state?.isLiveTrading);
  const paperExecutionEnabled = !!(state?.ok && !state?.isLiveTrading && isPaperEnv);
  const executionEnabled = liveExecutionEnabled || paperExecutionEnabled;
  const executionBlockerReason: string | null = !state?.ok
    ? 'Run a scan first to verify your broker resolution.'
    : !executionEnabled
      ? \`Active environment is "\${state.activeEnvironment ?? 'practice'}" — connect a broker for this mode (or switch to OANDA Live) to execute trades.\`
      : null;
  const meta = scan?.meta;`;
source = replaceOnce(source, oldDerived, newDerived, 'engine-aware derived scan state');

source = replaceOnce(
  source,
  "            <h2 style={{ margin: 0, fontSize: 18 }}>Signal scanner</h2>\n            <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13, maxWidth: 640 }}>\n              Multi-timeframe waterfall + entry-quality + asset-class qualification for forex, metals and indices.\n              Live scan results below — qualified signals, rejection rationale, open trades, and 30-minute trade\n              reassessments.\n            </p>",
  "            <h2 style={{ margin: 0, fontSize: 18 }}>\n              {selectedEngine === 'ppr' ? 'PPR — Price–Pool–Raid scanner' : selectedEngine === 'ict' ? 'ICT scanner' : 'V3 signal scanner'}\n            </h2>\n            <p style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13, maxWidth: 640 }}>\n              {selectedEngine === 'ppr'\n                ? 'Native PPR analysis only: Daily EMA9 bias, H1 EMA9 alignment, liquidity pools, M5 tick volume, manipulation confirmation, and PPR geometry.'\n                : selectedEngine === 'ict'\n                  ? 'Native ICT analysis only: liquidity, displacement, market structure shift, premium/discount, OTE, and killzone context.'\n                  : 'Independent V3 multi-timeframe waterfall, entry-quality, structure, liquidity, and execution analysis.'}\n            </p>",
  'engine-aware scanner heading',
);

source = replaceOnce(
  source,
  "            <StatChip label=\"Rejected\" value={String(rejected.length)} />",
  "            <StatChip label=\"Rejected\" value={String(rejected.length)} />\n" +
    "            <StatChip label=\"Active scanner\" value={selectedEngine.toUpperCase()} tone=\"good\" />",
  'active scanner chip',
);
source = source.replace(
  '{meta.v3EngineMode !== undefined && (',
  '{isV3Scan && meta.v3EngineMode !== undefined && (',
);
source = source.replace(
  '{meta.v3Comparison?.counts?.evaluated !== undefined && (',
  '{isV3Scan && meta.v3Comparison?.counts?.evaluated !== undefined && (',
);

const oldResultSections = `      {/* ── Recent signals (qualified) ──────────────────────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title={\`Recent signals (\${qualified.length})\`}
          subtitle="Qualified setups from the most recent scan with full waterfall + entry-quality detail."
        />
        {!state ? (
          <EmptyBlock>Run a scan to populate qualified signals.</EmptyBlock>
        ) : qualified.length === 0 ? (
          <EmptyBlock>
            No signals met the qualification threshold
            {meta?.minAlignmentScore && meta?.minConfidence
              ? \` (need alignment ≥ \${meta.minAlignmentScore}/100 and confidence ≥ \${meta.minConfidence}%).\`
              : '.'}
          </EmptyBlock>
        ) : (
          qualified.map((sig) => (
            <SignalCard
              key={\`\${sig.pair}_\${sig.direction}\`}
              signal={sig}
              executionEnabled={executionEnabled}
              executionBlockerReason={executionBlockerReason}
              isPaper={paperExecutionEnabled}
            />
          ))
        )}
      </section>

      {/* ── Rejected signals / scan details ──────────────────────────────── */}
      <section style={s.section}>
        <SectionHeader
          title={\`Rejected signals (\${rejected.length})\`}
          subtitle="Pairs that failed the waterfall — full rejection reasons and which layer they failed at."
        />
        {!state ? (
          <EmptyBlock>Run a scan to populate rejection details.</EmptyBlock>
        ) : rejected.length === 0 ? (
          <EmptyBlock>No rejections — all scanned pairs qualified.</EmptyBlock>
        ) : (
          rejected.slice(0, 20).map((sig, i) => <RejectedRow key={\`\${sig.pair ?? 'rejected'}_\${i}\`} sig={sig} />)
        )}
      </section>`;

const newResultSections = `      {isV3Scan ? (
        <>
          {/* ── Recent V3 signals (qualified) ─────────────────────────────── */}
          <section style={s.section}>
            <SectionHeader
              title={\`Recent signals (\${qualified.length})\`}
              subtitle="Qualified V3 setups from the most recent scan with full waterfall + entry-quality detail."
            />
            {!state ? (
              <EmptyBlock>Run a scan to populate qualified signals.</EmptyBlock>
            ) : qualified.length === 0 ? (
              <EmptyBlock>
                No signals met the qualification threshold
                {meta?.minAlignmentScore && meta?.minConfidence
                  ? \` (need alignment ≥ \${meta.minAlignmentScore}/100 and confidence ≥ \${meta.minConfidence}%).\`
                  : '.'}
              </EmptyBlock>
            ) : (
              qualified.map((sig) => (
                <SignalCard
                  key={\`\${sig.pair}_\${sig.direction}\`}
                  signal={sig}
                  executionEnabled={executionEnabled}
                  executionBlockerReason={executionBlockerReason}
                  isPaper={paperExecutionEnabled}
                />
              ))
            )}
          </section>

          {/* ── Rejected V3 signals / scan details ───────────────────────── */}
          <section style={s.section}>
            <SectionHeader
              title={\`Rejected signals (\${rejected.length})\`}
              subtitle="Pairs that failed the V3 waterfall — full rejection reasons and the failed layer."
            />
            {!state ? (
              <EmptyBlock>Run a scan to populate rejection details.</EmptyBlock>
            ) : rejected.length === 0 ? (
              <EmptyBlock>No rejections — all scanned pairs qualified.</EmptyBlock>
            ) : (
              rejected.slice(0, 20).map((sig, i) => <RejectedRow key={\`\${sig.pair ?? 'rejected'}_\${i}\`} sig={sig} />)
            )}
          </section>
        </>
      ) : (
        <NativeEngineScanPanel
          engine={selectedEngine === 'ppr' ? 'ppr' : 'ict'}
          qualified={qualified as any[]}
          watchCandidates={nativeWatchCandidates}
          rejected={rejected as any[]}
        />
      )}`;
source = replaceOnce(source, oldResultSections, newResultSections, 'native result sections');

for (const marker of [
  "NativeEngineScanPanel",
  "selectedEngine: 'ict' | 'v3' | 'ppr'",
  'Active scanner',
  "engine={selectedEngine === 'ppr' ? 'ppr' : 'ict'}",
  'signal-stack-engine-changed',
]) {
  if (!source.includes(marker)) throw new Error(`PPR scanner UI integration incomplete: ${marker}`);
}

fs.writeFileSync(target, source);
console.log('Authoritative PPR/ICT/V3 scanner UI applied.');
