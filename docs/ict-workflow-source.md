# ICT workflow source

Implementation source: **ICT Forex Trading — Complete Workflow & Strategy Guide (July 2026)** supplied by the project owner.

The engine implementation preserves the guide's objective sequence:

1. Higher-timeframe direction and draw on liquidity.
2. Meaningful liquidity raid or sweep.
3. Displacement and structural consequence (MSS, BOS, or CHoCH).
4. Retracement into a relevant PD array (FVG, order block, breaker, or OTE location).
5. Stop beyond true structural invalidation / the raid extreme.
6. Target opposing liquidity with at least the configured R:R floor.

Strategy routing covers ICT 2022, OTE continuation, Silver Bullet, Judas Swing, Turtle Soup, Power of Three, FVG continuation, order-block mitigation, and breaker-block contexts. SMT divergence remains supporting confluence rather than a standalone entry trigger.

The implementation deliberately does not create a new stack of mandatory confirmation gates. Strategy labels route already-detected ICT evidence; hard gates remain direction, timing, liquidity narrative, entry timing, news safety, executable geometry, confidence, risk, and R:R.

## Risk interpretation

Spot FX does not expose a complete public inventory of stop orders. The engine therefore labels wick/sweep behavior as a **liquidity-raid/manipulation-risk profile**, not verified manipulation. Initial stops may be widened before order submission to remain beyond structural invalidation and abnormal wick/ATR behavior. Position size is then reduced to keep dollar risk fixed. A live stop is never moved farther away.
