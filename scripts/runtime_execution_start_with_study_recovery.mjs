// Production Railway bootstrap.
// Apply recovery/compatibility patches first, then make the A-grade precision
// contract the final authority before server/index.js and schedulers are loaded.
await import('./apply_ftmo_market_study_recovery.mjs');
await import('./apply_ict_a_grade_precision.mjs');
await import('./runtime_execution_start.mjs');
