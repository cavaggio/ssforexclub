/**
 * web/app/dashboard/validate-actions.ts
 *
 * Server Action: re-check every saved broker connection's credentials and
 * persist validation_status. Used by the "Re-check connections" button on the
 * settings page. Derives userId from the Clerk session; never trusts the client.
 */

'use server';

import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { listBrokerConnectionsForUser } from '@/lib/brokerConnections';
import { validateAllConnections } from '@/lib/connectionValidation';

export type ValidateActionResult =
  | { ok: true; validated: number; failed: number; skipped: number; updateFailed: number; saved: number; persistWarning?: string }
  | { ok: false; error: string };

export async function validateConnectionsAction(): Promise<ValidateActionResult> {
  try {
    const { userId } = await auth();
    if (!userId) return { ok: false, error: 'Unauthenticated' };

    const connections = await listBrokerConnectionsForUser(userId);
    const outcomes = await validateAllConnections(userId, connections);

    revalidatePath('/dashboard/settings');
    revalidatePath('/dashboard/futures');
    revalidatePath('/dashboard/ftmo');

    const updateFailed = outcomes.filter((o) => o.updateFailed).length;
    return {
      ok: true,
      validated: outcomes.filter((o) => o.result === 'validated').length,
      failed: outcomes.filter((o) => o.result === 'failed').length,
      skipped: outcomes.filter((o) => o.result === 'skip').length,
      updateFailed,
      saved: outcomes.length,
      // A non-zero updateFailed means we validated but could NOT write the status.
      persistWarning: updateFailed > 0 ? 'Validation completed but status could not be saved.' : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
