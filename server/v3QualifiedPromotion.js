import { evaluateV3SetupStage, evaluateV3TriggerStage } from './v3QualityConfirmation.js';
import { computeV3EntryTpHitConfidence } from './v3TpConfidence.js';
import { scalpMinConfidence } from './scalpOnlyPolicy.js';
import {
  V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE,
  getLegacyPrimaryAlignmentScore,
  selectV3ReviewCandidates,
} from './v3LegacyBoundary.js';
import {
  buildV3Candidate,
  firstFinite,
  minimumExecutableRR,
  normalizeV3Direction,
} from './v3CandidateGeometry.js';

function enabled(value, fallback = false) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? fallback).toLowerCase());
}

export function promoteLegacyQualifiedForV3(scan = {}, log = () => {}) {
  const promoted = [];
  promoted.watchCandidates = [];
  if (!enabled(process.env.FOREX_V3_PROMOTE_ONLY, false)) return promoted;

  const minRR = minimumExecutableRR();
  for (const item of selectV3ReviewCandidates(scan, log)) {
    const v3 = item?.v3 || item?.v3Eval || item?.v3Analysis || item?.metadata?.v3;
    if (!v3) continue;

    const pair = item?.pair || v3?.pair;
    const direction = normalizeV3Direction(item?.direction || v3?.direction || v3?.signal);
    const built = buildV3Candidate(item, v3, minRR);
    const rr = firstFinite(item?.expectedRR, item?.rr, built?.expectedRR, v3?.expectedRR, v3?.rr);
    const entry = firstFinite(item?.entry, item?.entryPrice, item?.currentPrice, built?.entry, v3?.entry);
    const stopLoss = firstFinite(item?.stopLoss, item?.sl, built?.stopLoss, v3?.stopLoss, v3?.sl);
    const takeProfit = firstFinite(item?.takeProfit, item?.targetProfit, item?.tp, built?.takeProfit, v3?.takeProfit, v3?.tp);
    const legacyScore = getLegacyPrimaryAlignmentScore(item);

    const rawV3Score = firstFinite(v3?.score);
    let entryQualityConfidence = firstFinite(item?.confidence, v3?.confidence);
    if (Number.isFinite(rawV3Score)) {
      const boosted = rawV3Score + (v3?.qualified ? 14 : 0) + (v3?.earlyTrigger ? 5 : 0)
        + (Number(v3?.premiumDiscount?.premiumDiscountScore) >= 0.75 ? 5 : 0)
        + (Number(v3?.liquidityIntent?.intentScore ?? v3?.liquidityIntent?.score) >= 0.65 ? 6 : 0);
      entryQualityConfidence = Math.max(Number.isFinite(entryQualityConfidence) ? entryQualityConfidence : 0,
        Math.max(0, Math.min(100, Math.round(boosted))));
    }

    const base = {
      ...item, ...v3, ...(built || {}), pair, direction, entry, entryPrice: entry,
      stopLoss, takeProfit, targetProfit: takeProfit, expectedRR: rr, rr,
      entryQualityConfidence, legacyPrimaryAlignmentScore: legacyScore, v3,
    };
    const tpHitConfidence = computeV3EntryTpHitConfidence(base);
    const candidate = { ...base, confidence: tpHitConfidence, tpHitConfidence };
    const stage1 = evaluateV3SetupStage(candidate);
    const stage2 = stage1.allowed ? evaluateV3TriggerStage(candidate) : {
      stage: 2, allowed: false, state: 'blocked', reasons: ['stage 1 setup did not pass'],
      primaryTriggers: [], supports: [], checkedAt: new Date().toISOString(),
    };
    const confirmation = { stage1, stage2, checkedAt: new Date().toISOString() };

    if (stage1.allowed && !stage2.allowed) {
      promoted.watchCandidates.push({ pair, direction, confidence: tpHitConfidence,
        expectedRR: rr, legacyPrimaryAlignmentScore: legacyScore,
        reasons: stage2.reasons, qualityConfirmation: confirmation });
      continue;
    }

    const safe = pair && direction && stage1.allowed && stage2.allowed
      && [entry, stopLoss, takeProfit, tpHitConfidence, rr].every(Number.isFinite)
      && tpHitConfidence >= scalpMinConfidence() && rr >= minRR
      && legacyScore >= V3_LEGACY_MIN_PRIMARY_ALIGNMENT_SCORE;
    if (!safe) {
      log(`quality-reject pair=${pair || 'unknown'} legacyAlign=${legacyScore ?? 'missing'}`);
      continue;
    }

    promoted.push({ ...candidate, source: 'v3_promoted_quality_confirmed',
      finalQualifiedStatus: 'v3_quality_confirmed', qualityConfirmation: confirmation });
  }
  return promoted;
}
