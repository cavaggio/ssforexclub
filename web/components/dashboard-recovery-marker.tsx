'use client';

import { useEffect } from 'react';
import { DASHBOARD_RECOVERY_KEY } from '@/lib/dashboardRecovery';

const HEALTHY_RENDER_DELAY_MS = 10_000;

/**
 * Clears the stale-asset reload guard only after the dashboard has remained
 * mounted long enough to count as healthy. Without this, one recovered deploy
 * permanently disables automatic recovery for the rest of the browser tab.
 */
export function DashboardRecoveryMarker() {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        sessionStorage.removeItem(DASHBOARD_RECOVERY_KEY);
      } catch {
        // Storage can be unavailable in strict privacy modes.
      }
    }, HEALTHY_RENDER_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, []);

  return null;
}
