import 'server-only';

import { resolveActiveBrokerForUser } from './brokerResolver';
import { syncOandaTransactionsForUser } from './oandaTransactionSync';

export type TradeClosureReconciliation = {
  synced: number;
  warning: string | null;
};

function friendlyErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (
    lower.includes('522') ||
    lower.includes('connection timed out') ||
    lower.includes('cloudflare') ||
    lower.includes('gateway time-out') ||
    lower.includes('gateway timeout')
  ) {
    return 'Supabase is temporarily unreachable (Cloudflare 522 timeout). Trade reconciliation was skipped; no order settings were changed.';
  }

  return (normalized || 'temporary reconciliation error').slice(0, 300);
}

/**
 * Reconcile broker lifecycle events from OANDA's authoritative transaction
 * stream. The previous implementation inferred a close whenever an opened trade
 * disappeared from the current open-trade list. Because Trade Activity refreshes
 * repeatedly, that inference path could emit repeated phantom CLOSED rows for the
 * same position. Transaction IDs are stable broker facts and are therefore the
 * only source used here for TP/SL/manual/partial close reconciliation.
 *
 * Reconciliation is an auxiliary display/sync dependency. If Supabase or broker
 * resolution is temporarily unavailable (for example an upstream 522), this
 * function MUST return a warning instead of throwing and taking down the entire
 * Trade Activity endpoint.
 */
export async function reconcileBrokerClosuresForUser(userId: string): Promise<TradeClosureReconciliation> {
  try {
    const resolved = await resolveActiveBrokerForUser(userId);
    if (
      resolved.activeBroker !== 'oanda' ||
      resolved.brokerCredentialStatus !== 'ready' ||
      !resolved.getCredentials ||
      !resolved.baseUrl
    ) {
      return { synced: 0, warning: null };
    }

    const credentials = await resolved.getCredentials();
    if (!credentials) {
      return { synced: 0, warning: 'Broker credentials could not be decrypted.' };
    }

    const environment = resolved.activeEnvironment === 'live'
      ? 'live'
      : resolved.activeEnvironment === 'paper'
        ? 'paper'
        : 'practice';

    const sync = await syncOandaTransactionsForUser({
      userId,
      brokerAccountId: credentials.accountId,
      environment,
      baseUrl: resolved.baseUrl,
      token: credentials.token,
    });

    if (!sync.ok) {
      return {
        synced: 0,
        warning: `Broker transaction sync unavailable: ${sync.error || 'unknown OANDA transaction error'}`,
      };
    }

    return { synced: sync.logged, warning: null };
  } catch (error) {
    const message = friendlyErrorMessage(error);
    console.warn('[TRADE_ACTIVITY] reconciliation unavailable:', message);
    return {
      synced: 0,
      warning: `Trade reconciliation temporarily unavailable: ${message}`,
    };
  }
}
