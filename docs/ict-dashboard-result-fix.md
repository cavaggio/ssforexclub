# ICT dashboard result mapping fix

The ICT engine emits native direction signals as `buy` and `sell`. The dashboard response adapter now maps those values to qualified `long` and `short` rows rather than treating them as rejected.

The dashboard's 1.5R visibility filter is now limited to V3 executable cards. ICT retains all native rejection diagnostics so every scanned pair remains visible even when its computed risk/reward is below the execution floor.

This change affects presentation and response normalization only. It does not change ICT strategy qualification, confidence, risk, execution, or the 12-pair watchlist.
