/**
 * server/oandaDiagnostics.js
 * Checks OANDA connection health, env config, and account reachability.
 */

import { getOandaBaseUrl, getAccountId, oandaGet } from './oandaClient.js';

export async function runDiagnostics() {
  const result = {
    timestamp: new Date().toISOString(),
    env: process.env.OANDA_ENV || 'practice',
    baseUrl: null,
    apiKeySet: false,
    accountIdSet: false,
    connectionOk: false,
    accountReachable: false,
    accountBalance: null,
    accountCurrency: null,
    error: null,
  };

  try {
    result.baseUrl = getOandaBaseUrl();
    result.apiKeySet = !!(process.env.OANDA_API_KEY || '').trim();
    result.accountIdSet = !!(process.env.OANDA_ACCOUNT_ID || '').trim();

    if (!result.apiKeySet) {
      result.error = 'OANDA_API_KEY is not set.';
      return result;
    }
    if (!result.accountIdSet) {
      result.error = 'OANDA_ACCOUNT_ID is not set.';
      return result;
    }

    const accountId = getAccountId();
    const data = await oandaGet(`/v3/accounts/${accountId}/summary`);

    result.connectionOk = true;
    result.accountReachable = true;
    result.accountBalance = parseFloat(data.account?.balance || 0);
    result.accountCurrency = data.account?.currency || null;
  } catch (err) {
    result.connectionOk = false;
    result.error = err.message;
  }

  return result;
}
