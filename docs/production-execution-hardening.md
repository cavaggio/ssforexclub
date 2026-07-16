# Production execution hardening

This branch applies the centralized execution hardening patch and validates it before merge.

Scope:
- 1.25% maximum normal per-trade risk
- one authoritative 2.5% daily-loss cap
- projected daily-loss budget including open stop risk
- persistent setup fingerprints and atomic reservations
- post-stop-loss setup lockout
- universal timing, opposing-flow, pending-sweep, and range breakout/retest gates
- shared V3, legacy, and ICT execution policy
- TP-hit confidence retained as diagnostics, not initial entry confirmation
