from pathlib import Path
from datetime import datetime
import shutil
import sys

ROOT = Path.cwd()
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_v3_prop_candidate_{STAMP}"
BACKUP.mkdir(exist_ok=True)

def backup(path):
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def patch(path_str, fn):
    path = ROOT / path_str
    if not path.exists():
        print(f"❌ Missing {path_str}")
        sys.exit(1)
    backup(path)
    old = path.read_text()
    new = fn(old)
    if new == old:
        print(f"⚠️ No changes made to {path_str}")
    else:
        path.write_text(new)
        print(f"✅ Patched {path_str}")

def patch_scanner(text):
    # Add entry/price data to rejected payloads so V3 promotion can build RR later.
    replacements = [
        ("spreadPips: pricing.spreadPips, session,", "spreadPips: pricing.spreadPips, session,\n          entry: pricing.mid,\n          entryPrice: pricing.mid,\n          currentPrice: pricing.mid,\n          v3: v3Eval,"),
        ("spreadPips: pricing.spreadPips, session", "spreadPips: pricing.spreadPips, session,\n          entry: pricing.mid,\n          entryPrice: pricing.mid,\n          currentPrice: pricing.mid,\n          v3: v3Eval"),
    ]

    count = 0
    for old, new in replacements:
        if old in text:
            text = text.replace(old, new)
            count += 1

    if count == 0:
        print("⚠️ Scanner rejected payloads may already include entry/v3 or pattern changed.")

    return text

def patch_v3_auto(text):
    helper_marker = "function normalizeV3Direction(value) {"
    helper = """function getPipSizeLocal(pair = '') {
  return String(pair).includes('JPY') ? 0.01 : 0.0001;
}

function roundPriceLocal(price, pair = '') {
  if (!Number.isFinite(price)) return null;
  return Number(price.toFixed(String(pair).includes('JPY') ? 3 : 5));
}

function pickV3Target(v3 = {}, minRR = 1.5) {
  const targets = v3?.targets || {};
  const choices = [targets.tp1, targets.tp2, targets.tp3].filter(Boolean);

  for (const t of choices) {
    const pips = Math.abs(Number(t?.pips));
    const sl = Math.abs(Number(v3?.slPipsEst));
    if (Number.isFinite(pips) && Number.isFinite(sl) && sl > 0 && pips / sl >= minRR) {
      return t;
    }
  }

  return null;
}

function buildV3PropFirmCandidate(item = {}, v3 = {}, minRR = 1.5) {
  const pair = item?.pair || v3?.pair;
  const direction = normalizeV3Direction(item?.direction || v3?.direction || v3?.signal);
  const entry = Number(item?.entry ?? item?.entryPrice ?? item?.currentPrice ?? v3?.entry ?? v3?.entryPrice);

  if (!pair || !direction || !Number.isFinite(entry)) return null;

  const slPips = Math.abs(Number(v3?.slPipsEst));
  if (!Number.isFinite(slPips) || slPips <= 0) return null;

  const target = pickV3Target(v3, minRR);
  if (!target || !Number.isFinite(Number(target.price))) return null;

  const pipSize = getPipSizeLocal(pair);
  const stopLoss = direction === 'long'
    ? roundPriceLocal(entry - slPips * pipSize, pair)
    : roundPriceLocal(entry + slPips * pipSize, pair);

  const takeProfit = roundPriceLocal(Number(target.price), pair);
  const rewardPips = Math.abs(Number(target.pips));
  const rr = +(rewardPips / slPips).toFixed(2);

  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit) || rr < minRR) return null;

  return {
    pair,
    direction,
    entry,
    entryPrice: entry,
    stopLoss,
    targetProfit: takeProfit,
    takeProfit,
    expectedRR: rr,
    rr,
    stopLossPips: +slPips.toFixed(1),
    takeProfitPips: +rewardPips.toFixed(1),
    targetSource: target.source || v3?.targets?.targetSource || 'v3_liquidity',
  };
}

"""
    if "function buildV3PropFirmCandidate" not in text:
        text = text.replace(helper_marker, helper + helper_marker, 1)

    old_block = """    const entry = Number(item?.entry ?? item?.entryPrice ?? v3?.entry ?? v3?.entryPrice);
    const stopLoss = Number(item?.stopLoss ?? item?.sl ?? v3?.stopLoss ?? v3?.sl);
    const targetProfit = Number(item?.targetProfit ?? item?.takeProfit ?? item?.tp ?? v3?.targetProfit ?? v3?.takeProfit ?? v3?.tp);"""

    new_block = """    const builtV3Candidate = buildV3PropFirmCandidate(item, v3, minRR);

    const entry = Number(item?.entry ?? item?.entryPrice ?? item?.currentPrice ?? builtV3Candidate?.entry ?? v3?.entry ?? v3?.entryPrice);
    const stopLoss = Number(item?.stopLoss ?? item?.sl ?? builtV3Candidate?.stopLoss ?? v3?.stopLoss ?? v3?.sl);
    const targetProfit = Number(item?.targetProfit ?? item?.takeProfit ?? item?.tp ?? builtV3Candidate?.targetProfit ?? v3?.targetProfit ?? v3?.takeProfit ?? v3?.tp);"""

    if old_block in text:
        text = text.replace(old_block, new_block, 1)
    else:
        print("⚠️ V3 entry/SL/TP block not found or already patched.")

    old_rr = "const rr = envNum(item?.expectedRR ?? item?.rr ?? v3?.expectedRR ?? v3?.rr, NaN);"
    new_rr = "const rr = envNum(item?.expectedRR ?? item?.rr ?? builtV3Candidate?.expectedRR ?? v3?.expectedRR ?? v3?.rr, NaN);"
    if old_rr in text:
        text = text.replace(old_rr, new_rr, 1)

    old_push = """      entry,
      entryPrice: entry,
      stopLoss,
      targetProfit,
      takeProfit: targetProfit,"""

    new_push = """      ...(builtV3Candidate || {}),
      entry,
      entryPrice: entry,
      stopLoss,
      targetProfit,
      takeProfit: targetProfit,"""

    if old_push in text:
        text = text.replace(old_push, new_push, 1)

    old_log = """      log(`v3-only not promoted pair=${pair || 'unknown'} conf=${Number.isFinite(confidence) ? confidence : 'n/a'} rr=${Number.isFinite(rr) ? rr : 'n/a'} reason="${text || 'missing safe execution fields'}"`);"""

    new_log = """      log(
        `v3-only not promoted pair=${pair || 'unknown'} ` +
        `conf=${Number.isFinite(confidence) ? confidence : 'n/a'} ` +
        `rr=${Number.isFinite(rr) ? rr : 'n/a'} ` +
        `entry=${Number.isFinite(entry) ? entry : 'n/a'} ` +
        `sl=${Number.isFinite(stopLoss) ? stopLoss : 'n/a'} ` +
        `tp=${Number.isFinite(targetProfit) ? targetProfit : 'n/a'} ` +
        `targetSource=${builtV3Candidate?.targetSource || 'n/a'} ` +
        `reason="${text || 'missing safe execution fields'}"`
      );"""

    if old_log in text:
        text = text.replace(old_log, new_log, 1)

    return text

patch("server/oandaScanner.js", patch_scanner)
patch("server/v3AutoTrade.js", patch_v3_auto)

print(f"\\nBackups saved in {BACKUP}")
