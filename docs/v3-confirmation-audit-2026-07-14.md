# V3 confirmation audit — 2026-07-14

## Authoritative hard gates retained

- Daily/H4/M15 aggregate alignment: 2 of 3, minimum 67.
- V3 setup score: minimum 62.
- TP-hit confidence: minimum 85 at setup and revalidated at execution.
- Geometric R:R: minimum 1.5 and revalidated against fresh executable price.
- Fresh primary trigger: confirmed retest/sweep, aligned BOS/CHoCH, or compression-to-expansion.
- High-impact news, spread, target opportunity, signal age, price drift, entry distance, position sizing, margin, drawdown, duplicate-position and broker checks.

## Redundant confirmation removed

`V3_QUALITY_TRIGGER_MIN_SUPPORTS` is disabled for the native V3 runtime.

The supporting list (premium/discount, FVG/retest, session narrative, displacement and liquidity intent) is already represented in the V3 setup score and TP-hit confidence. Requiring an additional support count after a fresh primary trigger caused the same evidence to be counted multiple times. In particular, a confirmed retest was both a primary trigger and an `fvg_or_retest` support.

Supporting confirmations remain in Stage 2 metrics and logs for diagnostics and Edge Intelligence. They no longer independently reject a native V3 trade.

## Revalidation is intentional, not redundant

News, spread, R:R, freshness and TP-hit confidence are checked during setup and again immediately before order submission because market conditions and executable price can change. These checks were retained.

## Contradiction review

The legacy macro, structural and execution confidence floors and internal V3 structure-opposition gate were already converted to diagnostics. H1/M30/M5 remain context only. No safety or broker-risk gates were removed.
