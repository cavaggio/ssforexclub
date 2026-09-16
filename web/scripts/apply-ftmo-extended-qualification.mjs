import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROUTE = resolve(ROOT, 'app/api/cron/auto-ai-trading-extended/route.ts');
let source = readFileSync(ROUTE, 'utf8');

const brokerImport = "import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';\n";
const marketDataImport = `import {\n  getDecryptedBrokerCredentials,\n  listBrokerConnectionsForUser,\n  resolveBrokerBaseUrl,\n} from '@/lib/brokerConnections';\n`;
if (!source.includes(marketDataImport)) {
  if (!source.includes(brokerImport)) throw new Error('[FTMO_EXTENDED_QUALIFICATION] broker resolver import missing');
  source = source.replace(brokerImport, brokerImport + marketDataImport);
}

const helperAnchor = "const AUTO_AI_ENGINES: readonly AutoAiEngine[] = ['ict', 'v3', 'ppr'];\n";
const helper = `\ntype OandaMarketDataFeed = {\n  token: string;\n  accountId: string;\n  baseUrl: string;\n  environment: 'practice' | 'live';\n};\n\nasync function resolveFtmoMarketDataFeed(userId: string): Promise<OandaMarketDataFeed | null> {\n  const connections = await listBrokerConnectionsForUser(userId);\n  const candidates = connections\n    .filter((connection) =>\n      connection.broker === 'oanda' &&\n      connection.isActive &&\n      connection.validationStatus === 'validated' &&\n      (connection.environment === 'practice' || connection.environment === 'live'),\n    )\n    .sort((a, b) => {\n      if (a.environment === b.environment) return 0;\n      return a.environment === 'practice' ? -1 : 1;\n    });\n\n  for (const connection of candidates) {\n    const credentials = await getDecryptedBrokerCredentials(userId, connection.id);\n    if (!credentials || credentials.broker !== 'oanda') continue;\n    if (credentials.environment !== 'practice' && credentials.environment !== 'live') continue;\n    return {\n      token: credentials.token,\n      accountId: credentials.accountId,\n      environment: credentials.environment,\n      baseUrl: resolveBrokerBaseUrl('oanda', credentials.environment),\n    };\n  }\n  return null;\n}\n`;
if (!source.includes('async function resolveFtmoMarketDataFeed')) {
  if (!source.includes(helperAnchor)) throw new Error('[FTMO_EXTENDED_QUALIFICATION] engine anchor missing');
  source = source.replace(helperAnchor, helperAnchor + helper);
}

const oldResolution = `    try {\n      const resolved = await resolveActiveBrokerForUser(row.user_id);\n      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials || !resolved.baseUrl) {\n        results.push({\n          user: row.user_id,\n          engine: selectedEngine,\n          skipped: resolved.brokerCredentialStatus,\n          activeEnvironment: resolved.activeEnvironment,\n          reason: resolved.reason,\n        });\n        continue;\n      }\n\n      const credentials = await resolved.getCredentials();\n      if (!credentials) {\n        results.push({ user: row.user_id, engine: selectedEngine, skipped: 'decrypt_failed' });\n        continue;\n      }\n\n      for (const selectedEngine of selectedEngines) {\n        enabledEngines.add(selectedEngine);\n\n        const credentialBody = {\n          apiKey: credentials.token,\n          accountId: credentials.accountId,\n          baseUrl: resolved.baseUrl,\n          environment: resolved.activeEnvironment,\n          userId: row.user_id,\n          engine: selectedEngine,\n        };`;

const newResolution = `    try {\n      // Qualification is a market-data operation. A stale/disconnected MT5 EA\n      // must never suppress the FTMO user's scanner; execution readiness is\n      // re-checked only after a setup qualifies.\n      const resolved = await resolveActiveBrokerForUser(row.user_id, { requireExecutionReady: false });\n      if (resolved.brokerCredentialStatus !== 'ready' || !resolved.getCredentials) {\n        results.push({\n          user: row.user_id,\n          engine: selectedEngine,\n          skipped: resolved.brokerCredentialStatus,\n          activeEnvironment: resolved.activeEnvironment,\n          reason: resolved.reason,\n        });\n        continue;\n      }\n\n      const credentials = await resolved.getCredentials();\n      if (!credentials) {\n        results.push({ user: row.user_id, engine: selectedEngine, skipped: 'decrypt_failed' });\n        continue;\n      }\n\n      const ftmoMt5Execution = resolved.activeBroker === 'ftmo' && resolved.executionTransport === 'mt5_ea';\n      let scannerApiKey = credentials.token;\n      let scannerAccountId = credentials.accountId;\n      let scannerBaseUrl = resolved.baseUrl;\n      let scannerEnvironment = resolved.activeEnvironment;\n\n      if (ftmoMt5Execution) {\n        const marketData = await resolveFtmoMarketDataFeed(row.user_id);\n        if (!marketData) {\n          results.push({\n            user: row.user_id,\n            engine: selectedEngine,\n            skipped: 'ftmo_market_data_unavailable',\n            executionBroker: 'ftmo',\n            executionAccountId: credentials.accountId,\n          });\n          continue;\n        }\n        scannerApiKey = marketData.token;\n        scannerAccountId = marketData.accountId;\n        scannerBaseUrl = marketData.baseUrl;\n        scannerEnvironment = marketData.environment;\n        console.log(\n          \`[AUTO_AI][FTMO][runId=\${runId}] qualificationLane=active executionAccount=\${credentials.accountId} \` +\n          \`marketDataAccount=\${marketData.accountId} executionTransport=mt5_ea \` +\n          'qualificationIndependentOfMt5Readiness=true oandaExecutionFallback=false',\n        );\n      }\n\n      if (!scannerBaseUrl) {\n        results.push({\n          user: row.user_id,\n          engine: selectedEngine,\n          skipped: 'market_data_base_url_missing',\n          activeBroker: resolved.activeBroker,\n        });\n        continue;\n      }\n\n      for (const selectedEngine of selectedEngines) {\n        enabledEngines.add(selectedEngine);\n\n        const credentialBody = {\n          apiKey: scannerApiKey,\n          accountId: scannerAccountId,\n          baseUrl: scannerBaseUrl,\n          environment: scannerEnvironment,\n          userId: row.user_id,\n          engine: selectedEngine,\n          executionBroker: resolved.activeBroker,\n          executionAccountId: credentials.accountId,\n          executionEnvironment: resolved.activeEnvironment,\n          executionTransport: resolved.executionTransport ?? 'http',\n        };`;

if (!source.includes(newResolution)) {
  if (!source.includes(oldResolution)) throw new Error('[FTMO_EXTENDED_QUALIFICATION] extended scheduler resolution anchor missing');
  source = source.replace(oldResolution, newResolution);
}

for (const marker of [
  'requireExecutionReady: false',
  'ftmo_market_data_unavailable',
  'qualificationLane=active',
  'executionAccountId: credentials.accountId',
  "executionTransport: resolved.executionTransport ?? 'http'",
  'qualificationIndependentOfMt5Readiness=true',
  'oandaExecutionFallback=false',
]) {
  if (!source.includes(marker)) throw new Error(`[FTMO_EXTENDED_QUALIFICATION] missing ${marker}`);
}

writeFileSync(ROUTE, source, 'utf8');
console.log('[FTMO_EXTENDED_QUALIFICATION] extended Auto-AI route now scans FTMO via validated OANDA market data and defers MT5 readiness to execution.');
