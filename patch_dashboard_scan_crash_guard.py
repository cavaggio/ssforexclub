from pathlib import Path
import re
import sys

FILE = Path("web/components/scanner-status-card.tsx")

def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)

if not FILE.exists():
    die("web/components/scanner-status-card.tsx not found. Run from repo root.")

text = FILE.read_text()
original = text

# 1) Add compact/safe scan helpers after displayPair().
helper_marker = """function displayPair(pair: string): string {
  if (pair === 'XAU_USD') return 'Gold';
  if (pair === 'XAG_USD') return 'Silver';
  return pair.replace('_', '/');
}
"""

helper_add = """function displayPair(pair: string): string {
  if (pair === 'XAU_USD') return 'Gold';
  if (pair === 'XAG_USD') return 'Silver';
  return pair.replace('_', '/');
}

function safeNum(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function trimText(value: unknown, max = 500): string {
  const s = value == null ? '' : String(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function compactSignalPayload<T extends Record<string, any>>(sig: T): T {
  return {
    ...sig,
    reason: trimText(sig.reason, 500),
    rejectionReasons: Array.isArray(sig.rejectionReasons)
      ? sig.rejectionReasons.slice(0, 8).map((r: unknown) => trimText(r, 500))
      : sig.rejectionReasons,
    alignment: sig.alignment
      ? {
          ...sig.alignment,
          rejectionReasons: Array.isArray(sig.alignment.rejectionReasons)
            ? sig.alignment.rejectionReasons.slice(0, 8).map((r: unknown) => trimText(r, 500))
            : sig.alignment.rejectionReasons,
          warnings: Array.isArray(sig.alignment.warnings)
            ? sig.alignment.warnings.slice(0, 6).map((r: unknown) => trimText(r, 500))
            : sig.alignment.warnings,
        }
      : sig.alignment,
    institutionalFlow: sig.institutionalFlow
      ? {
          ...sig.institutionalFlow,
          reason: trimText(sig.institutionalFlow.reason, 500),
          signals: Array.isArray(sig.institutionalFlow.signals)
            ? sig.institutionalFlow.signals.slice(0, 6)
            : sig.institutionalFlow.signals,
        }
      : sig.institutionalFlow,
  };
}
"""

if "function safeNum(value: unknown)" not in text:
    if helper_marker not in text:
        die("Could not find displayPair helper block.")
    text = text.replace(helper_marker, helper_add, 1)

# 2) Make V3 panel safe when v3.liquidity is missing/partial.
old_v3_start = """function V3LiquidityPanel({ v3, pair, compact = false }: { v3: V3Meta; pair: string; compact?: boolean }) {
  const liq = v3.liquidity;
  const intent = v3.liquidityIntent;
"""

new_v3_start = """function V3LiquidityPanel({ v3, pair, compact = false }: { v3: V3Meta; pair: string; compact?: boolean }) {
  if (!v3?.liquidity) return null;
  const liq = v3.liquidity;
  const intent = v3.liquidityIntent;
"""

if old_v3_start in text:
    text = text.replace(old_v3_start, new_v3_start, 1)

# 3) Make runScan parse non-JSON safely and cap payload stored in React state.
old_parse = """      const raw = await res.json();

      if (!res.ok || !raw?.ok) {
"""

new_parse = """      const rawText = await res.text();
      let raw: any = {};
      try {
        raw = rawText ? JSON.parse(rawText) : {};
      } catch {
        raw = { ok: false, error: rawText.slice(0, 500) || `HTTP ${res.status}` };
      }

      if (!res.ok || !raw?.ok) {
"""

if old_parse in text:
    text = text.replace(old_parse, new_parse, 1)
elif "const rawText = await res.text();" not in text:
    die("Could not find runScan JSON parse block.")

old_set_scan = """      const scan = (raw.scan ?? {}) as Partial<ForexScanResult>;
      setState({
        ok: true,
        scan: {
          qualified: scan.qualified ?? [],
          rejected: scan.rejected ?? [],
          meta: scan.meta ?? ({} as ForexScanResult['meta']),
        },
"""

new_set_scan = """      const scan = (raw.scan ?? {}) as Partial<ForexScanResult>;
      const qualifiedSafe = Array.isArray(scan.qualified)
        ? scan.qualified.slice(0, 10).map((s: any) => compactSignalPayload(s))
        : [];
      const rejectedSafe = Array.isArray(scan.rejected)
        ? scan.rejected.slice(0, 20).map((s: any) => compactSignalPayload(s))
        : [];

      setState({
        ok: true,
        scan: {
          qualified: qualifiedSafe,
          rejected: rejectedSafe,
          meta: scan.meta ?? ({} as ForexScanResult['meta']),
        },
"""

if old_set_scan in text:
    text = text.replace(old_set_scan, new_set_scan, 1)
elif "qualifiedSafe" not in text:
    die("Could not find setState scan block.")

# 4) Guard account balance toFixed.
old_balance = """            {meta.accountBalanceUSD !== undefined && (
              <StatChip label="Account" value={`$${meta.accountBalanceUSD.toFixed(2)}`} />
            )}
"""

new_balance = """            {safeNum(meta.accountBalanceUSD) !== null && (
              <StatChip label="Account" value={`$${safeNum(meta.accountBalanceUSD)!.toFixed(2)}`} />
            )}
"""

if old_balance in text:
    text = text.replace(old_balance, new_balance, 1)

# 5) Make rejected rendering extra safe.
old_rejected_map = """          rejected.map((sig, i) => <RejectedRow key={`${sig.pair}_${i}`} sig={sig} />)
"""

new_rejected_map = """          rejected.slice(0, 20).map((sig, i) => <RejectedRow key={`${sig.pair ?? 'rejected'}_${i}`} sig={sig} />)
"""

if old_rejected_map in text:
    text = text.replace(old_rejected_map, new_rejected_map, 1)

if text == original:
    print("⚠️ No changes made.")
else:
    backup = FILE.with_suffix(".tsx.bak_scan_crash_guard")
    backup.write_text(original)
    FILE.write_text(text)
    print("✅ Patched scanner dashboard crash guards.")
    print(f"🗂️ Backup saved: {backup}")
