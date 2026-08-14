#!/usr/bin/env python3
"""Enforce scan/study-at-02:00 / execute-at-02:30 across every Auto AI engine.

The engine-neutral router passes executionAllowed=false during the 02:00–02:29
pre-entry scan period. Each native engine must still scan and publish its own
watch state, but it must not submit an order until the gate opens. The PPR pass
also preserves server-derived targetRiskUSD/manualExecution arguments used by
the qualified manual button.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"selected-engine execution gate marker missing: {label}")
    return text.replace(old, new, 1)


def replace_one_of(text: str, old_values: list[str], new: str, label: str) -> str:
    if new in text:
        return text
    matches = [old for old in old_values if old in text]
    if len(matches) != 1:
        raise RuntimeError(
            f"selected-engine execution gate marker missing/ambiguous: {label} ({len(matches)} matches)"
        )
    return text.replace(matches[0], new, 1)


# ICT
path = ROOT / "server" / "ictAutoTrade.js"
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "export async function runAutoAiForUser({ client, now = new Date(), runId = null, scanMode = 'full', pairs = null } = {}) {",
    "export async function runAutoAiForUser({\n"
    "  client,\n"
    "  now = new Date(),\n"
    "  runId = null,\n"
    "  scanMode = 'full',\n"
    "  pairs = null,\n"
    "  executionAllowed = true,\n"
    "  executionBlockedReason = null,\n"
    "} = {}) {",
    "ICT runner arguments",
)
ict_gate = """  if (executionAllowed === false) {
    const reason = executionBlockedReason || 'scan_only_until_02:30_ET_no_new_orders';
    const skipped = qualified.map((analysis) => ({
      pair: analysis.pair,
      direction: analysis.signal === 'buy' ? 'long' : 'short',
      reason,
    }));
    log(`scan-only gate active qualified=${qualified.length} executed=0 reason="${reason}"`);
    return {
      scanned: analyses.length,
      qualified: qualified.length,
      executed: [],
      skipped,
      executionAllowed: false,
      ...watchState,
    };
  }

  const executed = [];
  const skipped = [];"""
text = replace_once(
    text,
    "  const executed = [];\n  const skipped = [];",
    ict_gate,
    "ICT pre-entry gate",
)
path.write_text(text, encoding="utf-8")


# V3
path = ROOT / "server" / "v3AutoTrade.js"
text = path.read_text(encoding="utf-8")
text = replace_once(
    text,
    "  scanMode = 'full',\n  pairs = null,\n} = {}) {",
    "  scanMode = 'full',\n"
    "  pairs = null,\n"
    "  executionAllowed = true,\n"
    "  executionBlockedReason = null,\n"
    "} = {}) {",
    "V3 runner arguments",
)
v3_gate = """  if (executionAllowed === false) {
    const reason = executionBlockedReason || 'scan_only_until_02:30_ET_no_new_orders';
    const skipped = qualified.map((signal) => ({
      pair: signal.pair,
      direction: signal.direction,
      reason,
    }));
    log(`scan-only gate active qualified=${qualified.length} executed=0 reason="${reason}"`);
    return {
      engine: 'v3',
      architecture: 'independent_v3_raw_market_data',
      scanned: scan?.meta?.pairsScanned ?? qualified.length,
      qualified: qualified.length,
      executed: [],
      skipped,
      executionAllowed: false,
      v3Promoted: qualified.length,
      independentV3Qualified: qualified.length,
      qualityWatch: stageWatchCandidates.length,
      watchCandidates: stageWatchCandidates,
      ...watchState,
    };
  }

  const executed = [];
  const skipped = [];"""
text = replace_once(
    text,
    "  const executed = [];\n  const skipped = [];",
    v3_gate,
    "V3 pre-entry gate",
)
path.write_text(text, encoding="utf-8")


# PPR
path = ROOT / "server" / "pprAutoTrade.js"
text = path.read_text(encoding="utf-8")
text = replace_one_of(
    text,
    [
        "  scanMode = 'full',\n  pairs = null,\n} = {}) {",
        "  scanMode = 'full',\n  pairs = null,\n  targetRiskUSD = null,\n  manualExecution = false,\n} = {}) {",
    ],
    "  scanMode = 'full',\n"
    "  pairs = null,\n"
    "  targetRiskUSD = null,\n"
    "  manualExecution = false,\n"
    "  executionAllowed = true,\n"
    "  executionBlockedReason = null,\n"
    "} = {}) {",
    "PPR runner arguments",
)
ppr_gate = """  if (executionAllowed === false) {
    const reason = executionBlockedReason || 'scan_only_until_02:30_ET_no_new_orders';
    const skipped = qualified.map((candidate) => ({
      pair: candidate.pair,
      direction: candidate.direction,
      reason,
    }));
    log(
      `scan-only gate active scanned=${counts.scanned} qualified=${qualified.length} ` +
      `watching=${counts.watchCount} executed=0 reason="${reason}"`,
    );
    return {
      engine: 'ppr',
      architecture: 'independent_ppr_raw_market_data',
      legacyScannerUsed: false,
      v3LogicUsed: false,
      ictLogicUsed: false,
      scanned: counts.scanned,
      qualified: qualified.length,
      watching: counts.watchCount,
      rejectedCount: counts.rejectedCount,
      accountedFor: counts.accountedFor,
      countInvariantOk: counts.countInvariantOk,
      executionReadiness: counts.executionReadiness,
      executed: [],
      skipped,
      executionAllowed: false,
      watchCandidates: scan?.watchCandidates || [],
      rejected: scan?.rejected || [],
      pprRuntime: runtime,
      autoManageEnabled: runtime.aiAutoManageEnabled,
      ...watchState,
    };
  }

  if (!runtime.aiAutoExecutionEnabled) {"""
text = replace_once(
    text,
    "  if (!runtime.aiAutoExecutionEnabled) {",
    ppr_gate,
    "PPR pre-entry gate",
)
path.write_text(text, encoding="utf-8")

for relative in ["server/ictAutoTrade.js", "server/v3AutoTrade.js", "server/pprAutoTrade.js"]:
    body = (ROOT / relative).read_text(encoding="utf-8")
    for marker in [
        "executionAllowed = true",
        "executionBlockedReason = null",
        "scan_only_until_02:30_ET_no_new_orders",
        "executionAllowed: false",
    ]:
        if marker not in body:
            raise RuntimeError(f"execution gate incomplete in {relative}: missing {marker}")

ppr_body = (ROOT / "server/pprAutoTrade.js").read_text(encoding="utf-8")
for marker in ["targetRiskUSD = null", "manualExecution = false", "executePprTrade(executionCandidate"]:
    if marker not in ppr_body:
        raise RuntimeError(f"PPR manual-risk propagation incomplete: missing {marker}")

print("Selected-engine scan-only gate enforced: study/scans at 02:00, entries at 02:30; PPR manual target risk preserved")
