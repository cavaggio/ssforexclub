from pathlib import Path
from datetime import datetime
import shutil
import sys

ROOT = Path.cwd()
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = ROOT / f"backup_v3_executable_lane_{STAMP}"
BACKUP.mkdir(exist_ok=True)

def backup(path):
    dest = BACKUP / path.relative_to(ROOT)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)

def patch_file(rel, patcher):
    path = ROOT / rel
    if not path.exists():
        print(f"❌ Missing {rel}")
        sys.exit(1)

    backup(path)
    old = path.read_text()
    new = patcher(old)

    if new == old:
        print(f"⚠️ No changes made to {rel}")
    else:
        path.write_text(new)
        print(f"✅ Patched {rel}")

def patch_v3_auto(text):
    # Make V3 promotion executable when V3 itself is strong enough, even when legacy rejected.
    old = """    const confidence = envNum(item?.confidence ?? v3?.confidence ?? v3?.score, NaN);
    const rr = envNum(item?.expectedRR ?? item?.rr ?? builtV3Candidate?.expectedRR ?? v3?.expectedRR ?? v3?.rr, NaN);"""

    new = """    const rawV3Score = envNum(v3?.score, NaN);
    const v3Qualified = v3?.qualified === true;
    const v3Early = v3?.earlyTrigger === true;
    const pdScore = envNum(v3?.premiumDiscount?.premiumDiscountScore, 0);
    const liqScore = envNum(v3?.liquidityIntent?.intentScore ?? v3?.liquidityIntent?.score, 0);

    // Executable V3 confidence:
    // V3 score is not the same as legacy confidence. For execution, convert a
    // strong V3 setup into an execution confidence only when multiple V3 pillars agree.
    const v3ExecutionConfidence = (() => {
      if (!Number.isFinite(rawV3Score)) return NaN;

      let c = rawV3Score;

      if (v3Qualified) c += 14;
      if (v3Early) c += 5;
      if (pdScore >= 0.75) c += 5;
      if (liqScore >= 0.65) c += 6;

      return Math.max(0, Math.min(100, Math.round(c)));
    })();

    const confidence = envNum(
      item?.confidence ?? v3?.confidence,
      Number.isFinite(v3ExecutionConfidence) ? v3ExecutionConfidence : v3?.score
    );

    const rr = envNum(item?.expectedRR ?? item?.rr ?? builtV3Candidate?.expectedRR ?? v3?.expectedRR ?? v3?.rr, NaN);"""

    if old not in text:
        print("❌ Could not find confidence/RR block. Check v3AutoTrade.js manually.")
        sys.exit(1)

    text = text.replace(old, new, 1)

    old_safe = """      pair &&
      direction &&
      confidence >= minConfidence &&
      rr >= minRR &&
      Number.isFinite(entry) &&
      Number.isFinite(stopLoss) &&
      Number.isFinite(targetProfit) &&
      !news.blocked &&
      (isActiveOpportunityWindow(new Date()) || entryStatus !== 'late_entry') &&
      !text.includes('news_block') &&
      (isActiveOpportunityWindow(new Date()) || !text.includes('late_entry')) &&
      !text.includes('overextended') &&
      !text.includes('spread') &&
      !text.includes('margin') &&
      !text.includes('drawdown') &&
      !text.includes('risk cap');"""

    new_safe = """      pair &&
      direction &&
      confidence >= minConfidence &&
      rr >= minRR &&
      Number.isFinite(entry) &&
      Number.isFinite(stopLoss) &&
      Number.isFinite(targetProfit) &&
      !news.blocked &&
      !text.includes('news_block') &&
      !text.includes('spread') &&
      !text.includes('margin') &&
      !text.includes('drawdown') &&
      !text.includes('risk cap') &&
      !text.includes('daily loss') &&
      !text.includes('duplicate') &&
      (
        v3Qualified ||
        rawV3Score >= Number(process.env.FOREX_V3_EXECUTABLE_MIN_SCORE || 65)
      );"""

    if old_safe not in text:
        print("❌ Could not find promotion safe block. Check v3AutoTrade.js manually.")
        sys.exit(1)

    text = text.replace(old_safe, new_safe, 1)

    old_log = """    log(`v3-only promoted pair=${pair} dir=${direction} conf=${confidence} rr=${rr}`);"""

    new_log = """    log(
      `v3-only promoted pair=${pair} dir=${direction} ` +
      `conf=${confidence} rawV3Score=${Number.isFinite(rawV3Score) ? rawV3Score : 'n/a'} ` +
      `v3Qualified=${v3Qualified} early=${v3Early} ` +
      `pdScore=${pdScore} liqScore=${liqScore} rr=${rr}`
    );"""

    if old_log in text:
        text = text.replace(old_log, new_log, 1)

    return text

patch_file("server/v3AutoTrade.js", patch_v3_auto)

print(f"\\nBackups saved in {BACKUP}")
