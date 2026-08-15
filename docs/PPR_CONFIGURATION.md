# PPR Engine Configuration

PPR is an independent OANDA engine. It does not import legacy, V3, or ICT strategy qualification or management decisions.

## Fixed market scope

PPR scans only:

- `GBP_JPY`
- `EUR_GBP`
- `GBP_USD`

`PPR_FOREX_WATCHLIST` may select a subset of those pairs, but values outside the fixed list are ignored.

## Environment defaults

```env
PPR_FOREX_WATCHLIST=GBP_JPY,EUR_GBP,GBP_USD
PPR_DAILY_EMA=9
PPR_H1_EMA=9
PPR_MIN_CONFIDENCE=75
PPR_MIN_RR=1.5
PPR_VOLUME_LOOKBACK=20
PPR_VOLUME_SPIKE_MULTIPLIER=1.5
PPR_SWING_LOOKBACK=2
PPR_POOL_CLUSTER_TOLERANCE_PIPS=2
PPR_MAX_ENTRY_DISTANCE_PIPS=12
PPR_STOP_BUFFER_ATR=0.15
PPR_MAX_SPREAD_PIPS=5.0
```

## Operating rules

- New PPR scans and entries run from 02:00 through 09:59 America/New_York, Monday through Friday.
- Daily bias is determined from the Daily close relative to the EMA9 and the EMA9 slope.
- Final execution requires H1 price to remain on the matching side of the H1 EMA9.
- Volume confirmation is OANDA M5 tick volume at or above 1.5 times the preceding 20 completed M5 bars.
- A valid entry must contain one or more aligned misdirection components: a liquidity raid, FVG mitigation, or order-block retest.
- There is no fixed precedence among manipulation components and no static age expiration while the setup remains structurally valid.
- Price more than 12 pips from the valid manipulation is late. PPR waits for a retest within 12 pips with every other confirmation still valid.
- The stop is 0.15 M5 ATR beyond the manipulation invalidation.
- Liquidity targets are source-neutral clusters built from H1/M15 swings, equal highs/lows, previous-day levels, session extremes, previous-week levels, overlaps, and multiple touches.
- At 10:00 AM ET, PPR stops scanning, entering, and automated management. Open positions retain broker-attached SL/TP and become manual-only.
- PPR does not apply automated breakeven, partial exits, trailing stops, early-invalidation exits, or time exits.
- Existing centralized account-risk, margin, spread, duplicate, cooldown, confidence, total-open-risk, and post-fill R:R controls remain active.

## News policy

PPR-specific economic-news blocking is not configured. PPR does not inherit a news gate from legacy, V3, or ICT. A separate approved policy is required before news filtering is enabled.
