/**
 * web/app/dashboard/edge-intelligence/page.tsx
 *
 * Signal Stack V3 — Edge Intelligence tab.
 *
 * Auth-guarded (middleware + dashboard/layout also enforce it). The page renders
 * the original trade-attribution panel plus the account-scoped signal-learning
 * charts and versioned pair playbooks.
 */

import { auth } from '@clerk/nextjs/server';
import { EdgeIntelligencePanel } from '@/components/edge-intelligence-panel';
import { SignalLearningPanel } from '@/components/signal-learning-panel';

export const dynamic = 'force-dynamic';

export default async function EdgeIntelligencePage() {
  const { userId } = await auth();
  if (!userId) return null;
  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 28 }}>
      <EdgeIntelligencePanel />
      <SignalLearningPanel />
    </div>
  );
}
