// Production Railway bootstrap.
// Apply the FTMO/daily-study recovery patch before the normal runtime startup
// module imports server/index.js and starts the schedulers.
await import('./apply_ftmo_market_study_recovery.mjs');
await import('./runtime_execution_start.mjs');
