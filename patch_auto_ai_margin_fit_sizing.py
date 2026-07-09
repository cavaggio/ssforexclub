from pathlib import Path
from datetime import datetime
import shutil
import sys

FILE = Path("server/oandaTrade.js")
STAMP = datetime.now().strftime("%Y%m%d_%H%M%S")
BACKUP = Path(f"backup_auto_ai_margin_fit_{STAMP}")

if not FILE.exists():
    print("❌ Missing server/oandaTrade.js")
    sys.exit(1)

BACKUP.mkdir(exist_ok=True)
shutil.copy2(FILE, BACKUP / "oandaTrade.js")

text = FILE.read_text()
original = text

# Add a helper before executeTrade uses sizing, near the top-level helpers.
marker = "export async function executeTrade"
helper = """function fitUnitsToMargin({
  signedUnits,
  estimatedMargin,
  marginAvailable,
  minFreeMarginUSD,
} = {}) {
  const units = Number(signedUnits);
  const margin = Number(estimatedMargin);
  const available = Number(marginAvailable);
  const minFree = Number(minFreeMarginUSD);

  if (!Number.isFinite(units) || !Number.isFinite(margin) || margin <= 0) {
    return { signedUnits, changed: false, reason: 'invalid margin fit inputs' };
  }

  const maxUsableMargin = Math.max(0, available - minFree);
  if (maxUsableMargin <= 0) {
    return { signedUnits: 0, changed: true, reason: 'no usable margin after free-margin reserve' };
  }

  if (margin <= maxUsableMargin) {
    return { signedUnits, changed: false, reason: 'already fits margin reserve' };
  }

  const ratio = maxUsableMargin / margin;
  const fittedAbsUnits = Math.floor(Math.abs(units) * ratio);
  const fittedSignedUnits = units < 0 ? -fittedAbsUnits : fittedAbsUnits;

  return {
    signedUnits: fittedSignedUnits,
    changed: true,
    ratio,
    maxUsableMargin,
    reason: `reduced units to fit usable margin $${maxUsableMargin.toFixed(2)}`,
  };
}

"""

if "function fitUnitsToMargin" not in text:
    if marker not in text:
        print("❌ Could not find executeTrade export marker.")
        sys.exit(1)
    text = text.replace(marker, helper + marker, 1)

old_block = """  const units               = sizing.signedUnits;
  const absUnits            = Math.abs(units);
  const slPrice             = sizing.stopLoss;
  const tpPrice             = sizing.takeProfit;
  const estimatedMargin     = sizing.estimatedMarginRequired;
  const notionalUSD         = sizing.notionalUSD;
  const effectiveLeverage   = sizing.effectiveLeverage;
  const slDistancePips      = sizing.stopLossPips;

  if (!absUnits || absUnits < 1) {
    return blocked(
      `Sizing produced 0 units — pip value too small for $${dynamicRisk.riskUSD} risk at ${slDistancePips}p. ` +
      `pipValuePerLot=$${sizing.pipValuePerStandardLot}.`
    );
  }

  const minFreeMarginUSD    = balanceUSD * (MIN_FREE_MARGIN_PCT / 100);
  const projectedFreeMargin = marginAvailable - estimatedMargin;"""

new_block = """  let units                 = sizing.signedUnits;
  let absUnits              = Math.abs(units);
  const slPrice             = sizing.stopLoss;
  const tpPrice             = sizing.takeProfit;
  let estimatedMargin       = sizing.estimatedMarginRequired;
  let notionalUSD           = sizing.notionalUSD;
  const effectiveLeverage   = sizing.effectiveLeverage;
  const slDistancePips      = sizing.stopLossPips;

  const minFreeMarginUSD    = balanceUSD * (MIN_FREE_MARGIN_PCT / 100);

  if (autoAi) {
    const fit = fitUnitsToMargin({
      signedUnits: units,
      estimatedMargin,
      marginAvailable,
      minFreeMarginUSD,
    });

    if (fit.changed) {
      console.warn(
        `[AUTO_AI_MARGIN_FIT] ${pair} ${direction} ${fit.reason}; ` +
        `units ${units} → ${fit.signedUnits}`
      );

      units = fit.signedUnits;
      absUnits = Math.abs(units);

      if (absUnits >= 1) {
        const unitRatio = absUnits / Math.abs(sizing.signedUnits || 1);
        estimatedMargin = +(sizing.estimatedMarginRequired * unitRatio).toFixed(2);
        notionalUSD = +(sizing.notionalUSD * unitRatio).toFixed(2);
        sizing.signedUnits = units;
        sizing.tradeUnits = absUnits;
        sizing.estimatedMarginRequired = estimatedMargin;
        sizing.notionalUSD = notionalUSD;
        sizing.actualRiskUSD = +(sizing.actualRiskUSD * unitRatio).toFixed(2);
        sizing.estimatedRewardUSD = +(sizing.estimatedRewardUSD * unitRatio).toFixed(2);
      }
    }
  }

  if (!absUnits || absUnits < 1) {
    return blocked(
      `Sizing produced 0 units after margin fit — not enough free margin. ` +
      `available=$${marginAvailable.toFixed(2)} minFree=$${minFreeMarginUSD.toFixed(2)}`
    );
  }

  const projectedFreeMargin = marginAvailable - estimatedMargin;"""

if old_block not in text:
    print("❌ Could not find sizing/margin block.")
    print("Run: grep -nE \"const units|projectedFreeMargin|minFreeMarginUSD\" server/oandaTrade.js")
    sys.exit(1)

text = text.replace(old_block, new_block, 1)

if text == original:
    print("⚠️ No changes made.")
else:
    FILE.write_text(text)
    print("✅ Patched Auto AI margin-fit sizing.")
    print(f"Backup saved in {BACKUP}")
