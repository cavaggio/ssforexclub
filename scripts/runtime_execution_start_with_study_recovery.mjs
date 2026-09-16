// Production Railway bootstrap.
// Apply recovery/compatibility patches first, then make the A-grade precision
// contract and request-scoped execution identity the final authorities before
// server/index.js and schedulers are loaded.
await import('./apply_ftmo_market_study_recovery.mjs');
await import('./apply_ict_a_grade_precision.mjs');
await import('./apply_ict_a_grade_auto_contract.mjs');
await import('./apply_execution_metadata_context.mjs');
await import('./prepare_runtime_gate_agrade_compat.mjs');
await import('./runtime_execution_start.mjs');
