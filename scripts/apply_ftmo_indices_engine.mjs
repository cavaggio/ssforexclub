import fs from 'fs';

function patchFile(path, transform) {
  const original = fs.readFileSync(path, 'utf8');
  const updated = transform(original);
  if (updated !== original) fs.writeFileSync(path, updated);
}

patchFile('server/ftmoClient.js', (source) => {
  if (source.includes('export async function getFtmoSymbolSpec')) return source;
  return `${source.trimEnd()}\n\nexport async function getFtmoSymbolSpec(client, symbol) {\n  assertFtmoClient(client);\n  const normalized = clean(symbol);\n  if (!normalized) throw new Error('FTMO symbol is required');\n  return callFtmoBridge(client, '/v1/symbols/spec', { symbol: normalized });\n}\n\nexport async function getFtmoCandles(client, request = {}) {\n  assertFtmoClient(client);\n  const symbol = clean(request.symbol);\n  if (!symbol) throw new Error('FTMO candle symbol is required');\n  return callFtmoBridge(client, '/v1/market/candles', { request: { ...request, symbol } });\n}\n`;
});

patchFile('server/index.js', (source) => {
  let updated = source;
  if (!updated.includes("import ftmoIndicesRouter from './ftmoIndicesRouter.js';")) {
    const anchor = "import { PROVIDERS, assertExecutionProvider } from './providerRouting.js';";
    updated = updated.replace(anchor, `${anchor}\nimport ftmoIndicesRouter from './ftmoIndicesRouter.js';`);
  }
  if (!updated.includes("app.use('/api/indices', ftmoIndicesRouter);")) {
    const anchor = "app.use('/api/alpaca', alpacaAssets);";
    updated = updated.replace(anchor, `${anchor}\napp.use('/api/indices', ftmoIndicesRouter);`);
  }
  return updated;
});
