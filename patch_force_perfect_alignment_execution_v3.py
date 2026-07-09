from pathlib import Path
import re
import sys

SCANNER = Path("server/oandaScanner.js")

def die(msg):
    print(f"❌ {msg}", file=sys.stderr)
    sys.exit(1)

if not SCANNER.exists():
    die("server/oandaScanner.js not found. Run this from repo root.")

text = SCANNER.read_text()
original = text

helper_code = r'''

// === PERFECT ALIGNMENT EXECUTION BYPASS PATCH ===
function shouldForcePerfectAlignmentExecution({
  alignment,
  direction,
  newsRisk,
  pricing,
  maxSpread,
} = {}) {
  const alignScore = Number(alignment?.timeframeAlignmentScore ?? 0);
  const requiredScore = envNumber('FOREX_PERFECT_ALIGNMENT_BYPASS_SCORE', 100);

  if (alignScore < requiredScore) return { allowed: false, reason: `alignment_${alignScore}_below_${requiredScore}` };
  if (!direction) return { allowed: false, reason: 'missing_direction' };
  if (newsRisk?.blocked) return { allowed: false, reason: 'news_blocked' };
  if (Number(pricing?.spreadPips ?? 999) > Number(maxSpread ?? 0)) return { allowed: false, reason: 'spread_blocked' };

  return { allowed: true, reason: `perfect_alignment_${alignScore}` };
}

function softenPerfectAlignmentRejects(reasons = []) {
  return reasons.filter((reason) => {
    const r = String(reason || '').toLowerCase();

    // Keep real safety/protection blocks hard.
    if (typeof isProtectedHardBlock === 'function' && isProtectedHardBlock(r)) return true;
    if (r.includes('news block')) return true;
    if (r.includes('high-impact') && r.includes('news')) return true;
    if (r.includes('spread too wide')) return true;
    if (r.includes('spread too high')) return true;
    if (r.includes('rr < 1.5')) return true;
    if (r.includes('risk reward below')) return true;
    if (r.includes('missing stop')) return true;
    if (r.includes('missing take profit')) return true;
    if (r.includes('duplicate')) return true;
    if (r.includes('max trades')) return true;
    if (r.includes('daily loss')) return true;
    if (r.includes('credentials')) return true;
    if (r.includes('live trading disabled')) return true;
    if (r.includes('execution disabled')) return true;

    // Convert these to warnings for 100/100 alignment.
    if (
      r.includes('structural confidence') ||
      r.includes('execution confidence') ||
      r.includes('structure reversal risk is high') ||
      r.includes('reversal risk is high') ||
      r.includes('market state is reversal_risk') ||
      r.includes('profile does not allow reversal_risk') ||
      r.includes('forex profile does not allow reversal_risk') ||
      r.includes('late entry') ||
      r.includes('late_entry') ||
      r.includes('overextended') ||
      r.includes('over-extended') ||
      r.includes('risk monitor: last candle body') ||
      r.includes('candle strength') ||
      r.includes('candle has strong') ||
      r.includes('profile floor') ||
      r.includes('institutional flow') ||
      r.includes('flow opposes') ||
      r.includes('flow proxy') ||
      r.includes('impulse invalidated')
    ) {
      return false;
    }

    return true;
  });
}
// === END PERFECT ALIGNMENT EXECUTION BYPASS PATCH ===
'''

# Insert helper before opportunity patch helpers if possible.
if "function shouldForcePerfectAlignmentExecution" not in text:
    markers = [
        "// === OPPORTUNITY RANKING PATCH ===",
        "function getNYHour",
        "function envBool",
        "function prioritizeRetraceWatchPairs",
    ]

    inserted = False
    for marker in markers:
        idx = text.find(marker)
        if idx != -1:
            text = text[:idx] + helper_code + "\n" + text[idx:]
            inserted = True
            break

    if not inserted:
        text += "\n" + helper_code + "\n"

# Insert bypass directly before final rejection if block.
if "PERFECT_ALIGNMENT_BYPASS" not in text:
    reject_patterns = [
        r"      if \(!alignment\.tradeQualified \|\| !direction \|\| hardBlockedByEntryQuality\) \{",
        r"      if \(\s*!alignment\.tradeQualified\s*\|\|\s*!direction\s*\|\|\s*hardBlockedByEntryQuality\s*\)\s*\{",
    ]

    reject_match = None
    for pat in reject_patterns:
        reject_match = re.search(pat, text)
        if reject_match:
            break

    if not reject_match:
        die('Could not find final rejection block. Send me the output of: grep -n "alignment.tradeQualified\\|hardBlockedByEntryQuality" server/oandaScanner.js')

    bypass_code = r'''      const perfectAlignmentBypass = shouldForcePerfectAlignmentExecution({
        alignment,
        direction,
        newsRisk,
        pricing,
        maxSpread,
      });

      if (perfectAlignmentBypass.allowed && Array.isArray(alignment.rejectionReasons)) {
        const beforeReasons = alignment.rejectionReasons.length;
        const removedReasons = alignment.rejectionReasons.filter((reason) => {
          return softenPerfectAlignmentRejects([reason]).length === 0;
        });

        alignment.rejectionReasons = softenPerfectAlignmentRejects(alignment.rejectionReasons);

        if (alignment.rejectionReasons.length < beforeReasons) {
          if (!Array.isArray(alignment.warnings)) alignment.warnings = [];

          alignment.warnings.push(
            `Perfect-alignment bypass: converted secondary blockers to warnings. ` +
            `${removedReasons.join(' | ')}`
          );

          console.log(
            `[PERFECT_ALIGNMENT_BYPASS] ${pair} ${direction ?? '—'} ` +
            `softened=${beforeReasons - alignment.rejectionReasons.length}/${beforeReasons} ` +
            `remaining=${alignment.rejectionReasons.length} reason=${perfectAlignmentBypass.reason}`
          );
        }

        if (alignment.rejectionReasons.length === 0) {
          alignment.tradeQualified = true;
        }
      }

'''

    text = text[:reject_match.start()] + bypass_code + text[reject_match.start():]

# Modify final rejection condition so perfect alignment bypass can override soft entry blocks.
text = re.sub(
    r"      if \(!alignment\.tradeQualified \|\| !direction \|\| hardBlockedByEntryQuality\) \{",
    "      if (!alignment.tradeQualified || !direction || (hardBlockedByEntryQuality && !(perfectAlignmentBypass?.allowed && !newsRisk.blocked))) {",
    text,
    count=1
)

# Confidence floor.
if "PERFECT_ALIGNMENT_CONFIDENCE_FLOOR" not in text:
    old_conf = """      const confidence = Math.max(0, Math.min(100,
        baseConfidence + (institutionalFlow.confidenceImpact || 0)
      ));

      if (confidence < MIN_CONFIDENCE) {
"""
    new_conf = """      let confidence = Math.max(0, Math.min(100,
        baseConfidence + (institutionalFlow.confidenceImpact || 0)
      ));

      if (perfectAlignmentBypass?.allowed && confidence < MIN_CONFIDENCE) {
        if (!Array.isArray(alignment.warnings)) alignment.warnings = [];
        alignment.warnings.push(
          `Perfect-alignment confidence floor: raw confidence ${confidence}% raised to min ${MIN_CONFIDENCE}% for execution sizing.`
        );
        console.log(
          `[PERFECT_ALIGNMENT_CONFIDENCE_FLOOR] ${pair} ${direction} raw=${confidence} floor=${MIN_CONFIDENCE}`
        );
        confidence = MIN_CONFIDENCE;
      }

      if (confidence < MIN_CONFIDENCE) {
"""
    if old_conf in text:
        text = text.replace(old_conf, new_conf, 1)
    else:
        print("⚠️ Could not find exact confidence block; skipping confidence floor.")

# Expected RR bypass.
if "PERFECT_ALIGNMENT_RR_BYPASS" not in text:
    text = text.replace("      const rrQual = computeExpectedRR({", "      let rrQual = computeExpectedRR({", 1)

    old_rr = "      if (!rrQual.accepted) {\n"
    new_rr = """      if (
        !rrQual.accepted &&
        perfectAlignmentBypass?.allowed &&
        Number(rrQual?.factors?.geometricRR ?? 0) >= 1.5
      ) {
        if (!Array.isArray(alignment.warnings)) alignment.warnings = [];
        alignment.warnings.push(
          `Perfect-alignment RR bypass: geometric RR ${rrQual.factors.geometricRR} >= 1.5, expected-R warning only. ${rrQual.rejectionReason}`
        );
        console.log(
          `[PERFECT_ALIGNMENT_RR_BYPASS] ${pair} ${direction} ` +
          `geometricRR=${rrQual.factors.geometricRR} expectedRR=${rrQual.expectedRR}`
        );

        rrQual = {
          ...rrQual,
          accepted: true,
          rrTier: rrQual.rrTier === 'reject' ? 'standard' : rrQual.rrTier,
          rejectionReason: null,
        };
      }

      if (!rrQual.accepted) {
"""
    if old_rr in text:
        text = text.replace(old_rr, new_rr, 1)
    else:
        print("⚠️ Could not find rrQual accepted block; skipping RR bypass.")

if text == original:
    print("⚠️ No changes made.")
else:
    backup = SCANNER.with_suffix(".js.bak_force_perfect_alignment_v3")
    backup.write_text(original)
    SCANNER.write_text(text)
    print("✅ Patched server/oandaScanner.js")
    print(f"🗂️ Backup saved: {backup}")

print("\nVerify:")
print('grep -n "PERFECT_ALIGNMENT_BYPASS\\|PERFECT_ALIGNMENT_CONFIDENCE_FLOOR\\|PERFECT_ALIGNMENT_RR_BYPASS\\|shouldForcePerfectAlignmentExecution" server/oandaScanner.js')
