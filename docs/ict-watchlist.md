# ICT scanner watchlist

ICT full scans use the following 12 core forex pairs:

- EUR_USD
- GBP_USD
- USD_JPY
- USD_CAD
- USD_CHF
- AUD_USD
- NZD_USD
- EUR_GBP
- EUR_CHF
- AUD_CAD
- GBP_JPY
- EUR_JPY

The list mirrors V3's default market universe, while remaining owned by ICT so no strategy logic or module dependency is shared between the engines. `ICT_PAIRS` and `FOREX_WATCHLIST` may add instruments, but cannot remove the 12 core pairs from ICT full scans.
