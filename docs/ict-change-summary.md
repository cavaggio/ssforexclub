# ICT 93% / manipulation-risk / lifecycle alignment

This change set enforces one authoritative ICT confidence floor of **93%** across dashboard qualification, autonomous selection, and server-side execution.

It adds a pre-entry liquidity-raid risk profile based on confirmed sweeps, wick-to-ATR behavior, repeated rejection wicks, and range expansion. Initial stops are placed beyond structural invalidation with an adaptive buffer. Claude may recommend a small additional pre-entry buffer, but deterministic code limits that recommendation by ATR and the minimum R:R floor. Position sizing is recalculated from the final stop so widening never increases fixed dollar risk. Existing live stops are never widened.

ICT entries persist their original confidence, setup type, stop, target, ATR, and projected hold time. Reassessment identifies ICT trades from this entry snapshot, preserves the original qualified confidence and HOLD decision until the planned hold expires, and then uses the ICT lifecycle engine rather than the legacy entry-confidence waterfall. Automatic close remains restricted to post-hold ICT invalidation/CLOSE evidence plus the existing near-stop safety gate.

Strategy routing applies the supplied ICT workflow to already-detected concepts without creating another stack of mandatory confirmations. SMT remains supporting confluence rather than a standalone entry model.
