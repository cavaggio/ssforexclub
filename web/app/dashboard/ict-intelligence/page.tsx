/**
 * web/app/dashboard/ict-intelligence/page.tsx
 *
 * ICT Intelligence tab. Auth-guarded thin Server Component that renders the
 * client IctIntelligencePanel, which fetches /api/ict/analyze and renders the
 * ICT-first analysis per pair. Shadow only — no trade is ever placed here.
 */

import { auth } from '@clerk/nextjs/server';
import { IctIntelligencePanel } from '@/components/ict-intelligence-panel';

export const dynamic = 'force-dynamic';

export default async function IctIntelligencePage() {
  const { userId } = await auth();
  if (!userId) return null;
  return (
    <div style={{ maxWidth: 1180, margin: '0 auto', width: '100%' }}>
      <IctIntelligencePanel />
    </div>
  );
}
