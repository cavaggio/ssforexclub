/**
 * web/app/dashboard/edge-intelligence/page.tsx
 *
 * Signal Stack V3 — Edge Intelligence tab.
 *
 * Auth-guarded (middleware + dashboard/layout also enforce it). The page is a
 * thin Server Component that renders the client EdgeIntelligencePanel, which
 * fetches /api/edge-intelligence and renders the AI Trade Intelligence briefing
 * plus the attribution breakdowns.
 */

import { auth } from '@clerk/nextjs/server';
import { EdgeIntelligencePanel } from '@/components/edge-intelligence-panel';

export const dynamic = 'force-dynamic';

export default async function EdgeIntelligencePage() {
  const { userId } = await auth();
  if (!userId) return null;
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', width: '100%' }}>
      <EdgeIntelligencePanel />
    </div>
  );
}
