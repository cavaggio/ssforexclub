import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = resolve(ROOT, 'server/index.js');

const source = readFileSync(INDEX, 'utf8');
const before = `    const client = createOandaClient({ apiKey, accountId, baseUrl, environment, userId });
    // Guardrail: any internal-endpoint call MUST use the per-request client.
    // Surface a structured log with masked accountId. Never log apiKey/token.
    return client;`;
const after = `    const client = createOandaClient({ apiKey, accountId, baseUrl, environment, userId });
    // The OANDA client may be market-data-only for an FTMO-selected user. Keep
    // the execution identity attached to the request-scoped client so scanner
    // audit rows are account-scoped to FTMO rather than the OANDA feed account.
    const executionBroker = String(body?.executionBroker || '').trim().toLowerCase();
    const executionTransport = String(body?.executionTransport || '').trim().toLowerCase();
    client.executionBroker = executionBroker || 'oanda';
    client.executionAccountId = String(body?.executionAccountId || accountId || '').trim() || accountId;
    client.executionEnvironment = String(body?.executionEnvironment || environment || '').trim() || environment;
    client.executionTransport = executionTransport || 'http';
    if (executionBroker === 'ftmo' && executionTransport === 'mt5_ea') {
      client.executionProvider = 'ftmo_mt5_ea';
      client.marketDataProvider = 'oanda';
    }
    // Guardrail: any internal-endpoint call MUST use the per-request client.
    // Surface a structured log with masked accountId. Never log apiKey/token.
    return client;`;

let output = source;
if (!output.includes(after)) {
  if (!output.includes(before)) {
    throw new Error('[EXECUTION_METADATA_CONTEXT] buildClientFromBody anchor not found');
  }
  output = output.replace(before, after);
  writeFileSync(INDEX, output, 'utf8');
}

for (const marker of [
  'client.executionAccountId =',
  "client.executionProvider = 'ftmo_mt5_ea'",
  "client.marketDataProvider = 'oanda'",
]) {
  if (!output.includes(marker)) throw new Error(`[EXECUTION_METADATA_CONTEXT] missing ${marker}`);
}
console.log('[EXECUTION_METADATA_CONTEXT] request-scoped FTMO execution identity preserved on OANDA market-data client.');
