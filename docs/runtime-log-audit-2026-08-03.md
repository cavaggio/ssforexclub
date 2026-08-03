# Railway runtime log audit — 2026-08-03

Source export: `logs.1785765970138.csv` supplied by the operator.

## Time coverage

The 1,001-row export covers 2026-08-03 09:02:12–09:04:57 America/New_York. It is not a complete export from 02:00 ET.

## Confirmed findings

- Four Railway deployment replicas overlapped during the export. Each replica initialized the scheduler and launched a startup scan.
- Ten pair-analysis batches were visible, covering 70 pair evaluations total.
- EUR_USD, GBP_USD, USD_JPY, and GBP_JPY had aligned Daily/4H direction but no generated 5M signal during the captured interval.
- XAU_USD, US30_USD, and SPX500_USD failed Daily/4H alignment.
- All visible Auto AI cycles reported zero qualified, zero executed, and zero execution-skipped candidates.
- The runtime reported ICT `minConfidence=85`, contradicting the approved 80% execution threshold and potentially excluding signals scoring 80–84.
- Every deployment logged a manual target-risk compatibility error because the patcher expected an obsolete single-name risk-manager import.
- Engine-learning migrations `20260730110000` and `20260730162000` were reported missing. Trading remained active, but combined learning/calibration remained degraded.
- The export predates the exact `[ICT_REJECT_REASON]` diagnostic deployment, so individual scanner rejection gates are not present in this file.

## Code corrections

- Enforce exactly 80% for ICT scanner and executor qualification, ignoring stale stricter Railway values.
- Set both legacy and execution-specific ICT confidence environment values to 80 before the engine is imported.
- Patch the current combined risk-manager import and initialize trusted manual target-risk propagation before the legacy compatibility pass runs.
- Keep the patch as the final runtime generation pass so older source generators cannot restore the inaccurate settings.

## Operational follow-up

The Supabase migrations still need to be applied to restore the full engine-learning views. That database operation is separate from this code correction.
