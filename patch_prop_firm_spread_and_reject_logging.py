from pathlib import Path
from datetime import datetime
import shutil
import sys

ROOT = Path.cwd()
FILE = ROOT / "server/oandaScanner.js"
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_prop_firm_scan_{STAMP}"

if not FILE.exists():
    print("❌ Missing server/oandaScanner.js")
    sys.exit(1)

BACKUP.mkdir(exist_ok=True)
shutil.copy2(FILE, BACKUP / "oandaScanner.js")

text = FILE.read_text()
original = text

old_fn = """function getOandaMaxSpreadPips(instrument, session) {
  const pair = String(instrument).replace('/', '_').toUpperCase();

  if (pair === 'EUR_USD') return 3;
  if (pair === 'GBP_USD') return 4;
  if (pair === 'AUD_USD') return 5;
  if (pair === 'NZD_USD') return 6;
  if (pair === 'USD_CAD') return 6;
  if (pair === 'USD_JPY') return 5;

  if (pair.includes('JPY')) return 12;
  if (pair.includes('GBP')) return 8;

  return 6;
}"""

new_fn = """function getOandaMaxSpreadPips(instrument, session) {
  const pair = String(instrument).replace('/', '_').toUpperCase();

  const propFirmCap = Number.isFinite(Number(process.env.FOREX_MAX_SPREAD_PIPS))
    ? Number(process.env.FOREX_MAX_SPREAD_PIPS)
    : 3.5;

  let pairLimit = 6;

  if (pair === 'EUR_USD') pairLimit = 3;
  else if (pair === 'GBP_USD') pairLimit = 4;
  else if (pair === 'AUD_USD') pairLimit = 5;
  else if (pair === 'NZD_USD') pairLimit = 6;
  else if (pair === 'USD_CAD') pairLimit = 6;
  else if (pair === 'USD_JPY') pairLimit = 5;
  else if (pair.includes('JPY')) pairLimit = 12;
  else if (pair.includes('GBP')) pairLimit = 8;

  return Math.min(pairLimit, propFirmCap);
}"""

if old_fn not in text:
    print("❌ Could not find getOandaMaxSpreadPips block.")
    sys.exit(1)

text = text.replace(old_fn, new_fn, 1)

# Add always-on final rejection logging after scan complete, before V3 shadow section.
marker = """  console.log(`\\n[SCANNER] ▶ Scan complete — ${qualified.length} qualified, ${rejected.length} rejected\\n`);

  // ── Signal Stack V3 shadow comparison ─────────────────────────────────────"""

insert = """  console.log(`\\n[SCANNER] ▶ Scan complete — ${qualified.length} qualified, ${rejected.length} rejected\\n`);

  for (const r of rejected.slice(0, 20)) {
    const reasons = Array.isArray(r.rejectionReasons)
      ? r.rejectionReasons.slice(0, 4).join(' | ')
      : String(r.reason || 'unknown');

    const v3 = r.v3 || v3ByPair?.[r.pair] || null;

    console.log(
      `[FINAL_REJECT] ${r.pair} dir=${r.direction ?? 'none'} ` +
      `cat=${r.rejectionCategory ?? 'unknown'} ` +
      `reason="${String(r.reason || 'unknown').slice(0, 180)}" ` +
      `v3Score=${v3?.score ?? 'n/a'} v3Qualified=${v3?.qualified === true} ` +
      `v3Early=${v3?.earlyTrigger === true} ` +
      `pd=${v3?.premiumDiscount?.premiumDiscountState ?? 'n/a'} ` +
      `reasons="${reasons.slice(0, 500)}"`
    );
  }

  // ── Signal Stack V3 shadow comparison ─────────────────────────────────────"""

if marker not in text:
    print("❌ Could not find scan-complete marker for FINAL_REJECT logging.")
    sys.exit(1)

text = text.replace(marker, insert, 1)

FILE.write_text(text)

print("✅ Patched scanner spread ceiling and final rejection logging.")
print(f"Backup saved in {BACKUP}")
