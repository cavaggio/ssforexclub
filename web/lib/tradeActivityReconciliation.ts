import 'server-only';

import { resolveActiveBrokerForUser } from './brokerResolver';
import { syncOandaTransactionsForUser } from './oandaTransactionSync';

export type TradeClosureReconciliation = {
  synced: number;
  warning: string | null;
};

/**
 * Reconcile broker lifecycle events from OANDA's authoritative transaction
 * stream. The previous implementation inferred a close whenever an opened trade
 * disappeared from the current open-trade list. Because Trade Activity refreshes
 * repeatedly, that inference path could emit repeated phantom CLOSED rows for
 * the same position. Transaction IDs are stable broker facts and are therefore
 * the only source used here for TP/SL/manual/partial close reconciliation.
 */
export async function reconcileBrokerClosuresForUser(userId: string): Promise<TradeClosureReconciliation> {
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
}
