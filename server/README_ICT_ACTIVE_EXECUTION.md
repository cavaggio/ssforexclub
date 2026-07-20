# ICT active execution contract

`ICT_ENGINE_MODE=active` and `ICT_AUTO_TRADE_ENABLED=true` authorize ICT order submission for the selected OANDA account.

- Practice and paper accounts do not require `FOREX_ALLOW_LIVE_EXECUTION`.
- Live accounts still require `FOREX_ALLOW_LIVE_EXECUTION=true` and the existing platform acknowledgement flow.
- `shadow` remains analysis-only.
- Legacy `live` mode remains accepted for backward compatibility.
