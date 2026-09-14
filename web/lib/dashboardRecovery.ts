export const DASHBOARD_RECOVERY_KEY = 'signal-stack-dashboard-chunk-recovery';
export const DASHBOARD_RECOVERY_COOLDOWN_MS = 60_000;

const STALE_ASSET_ERROR = /ChunkLoadError|Loading (?:CSS )?chunk|Failed to (?:fetch dynamically imported module|load (?:chunk|script|RSC payload))|CSS_CHUNK_LOAD_FAILED|React Client Manifest|_next\/static/i;

export function isStaleDashboardAssetError(error: Error): boolean {
  return STALE_ASSET_ERROR.test([error.name, error.message, error.stack].filter(Boolean).join('\n'));
}
