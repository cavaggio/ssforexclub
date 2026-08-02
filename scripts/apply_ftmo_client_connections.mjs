import fs from 'fs';

function patchFile(path, transform) {
  const original = fs.readFileSync(path, 'utf8');
  const updated = transform(original);
  if (updated !== original) fs.writeFileSync(path, updated);
}

patchFile('server/index.js', (source) => {
  let updated = source;

  const compactImport = "import { buildFtmoClient, validateFtmoCredentials } from './ftmoClient.js';";
  const completeImport = `import {
  buildFtmoClient,
  validateFtmoCredentials,
  ftmoConnectivityCheck,
  getFtmoAccountSummary,
  getFtmoPositions,
  placeFtmoOrder,
  closeFtmoPosition,
  getFtmoDiagnostics,
} from './ftmoClient.js';`;

  if (updated.includes(compactImport)) {
    updated = updated.replace(compactImport, completeImport);
  }

  if (!updated.includes("from './ftmoConnectionStore.js'")) {
    const anchor = completeImport;
    if (updated.includes(anchor)) {
      updated = updated.replace(
        anchor,
        `${anchor}\nimport { getFtmoConnection, saveFtmoConnection, testFtmoConnection, deleteFtmoConnection } from './ftmoConnectionStore.js';`,
      );
    }
  }

  updated = updated.replace(
    "app.use('/api/indices', ftmoIndicesRouter);",
    "app.use('/api/indices', authenticateToken, ftmoIndicesRouter);",
  );

  if (!updated.includes("app.get('/api/ftmo/connection'")) {
    const anchor = "app.post('/api/alpaca/credentials', authenticateToken, async (req, res) => {";
    const routes = `app.get('/api/ftmo/connection', authenticateToken, async (req, res) => {\n  try {\n    const connection = await getFtmoConnection(req.user.userId);\n    res.json({ ok: true, connection });\n  } catch (error) {\n    console.error('[FTMO CONNECTION GET ERROR]', error);\n    res.status(500).json({ ok: false, error: error?.message || String(error) });\n  }\n});\n\napp.put('/api/ftmo/connection', authenticateToken, async (req, res) => {\n  try {\n    const connection = await saveFtmoConnection(req.user.userId, req.body || {});\n    res.json({ ok: true, connection });\n  } catch (error) {\n    console.error('[FTMO CONNECTION SAVE ERROR]', error);\n    res.status(400).json({ ok: false, error: error?.message || String(error), missing: error?.missing || [] });\n  }\n});\n\napp.post('/api/ftmo/connection/test', authenticateToken, async (req, res) => {\n  try {\n    const connection = await testFtmoConnection(req.user.userId);\n    res.status(connection.ok ? 200 : 409).json({ ok: connection.ok, connection });\n  } catch (error) {\n    console.error('[FTMO CONNECTION TEST ERROR]', error);\n    res.status(400).json({ ok: false, error: error?.message || String(error) });\n  }\n});\n\napp.delete('/api/ftmo/connection', authenticateToken, async (req, res) => {\n  try {\n    const result = await deleteFtmoConnection(req.user.userId);\n    res.json({ ok: true, ...result });\n  } catch (error) {\n    console.error('[FTMO CONNECTION DELETE ERROR]', error);\n    res.status(500).json({ ok: false, error: error?.message || String(error) });\n  }\n});\n\n`;
    if (updated.includes(anchor)) updated = updated.replace(anchor, `${routes}${anchor}`);
  }

  // The Next.js dashboard decrypts the selected user's bridge credentials and
  // forwards them to these internal routes. They remain isolated from OANDA and
  // are asserted against provider=ftmo before any bridge call is made.
  if (!updated.includes("app.post('/api/internal/ftmo/diagnostics'")) {
    const anchor = '// POST /api/internal/oanda/risk-status';
    const routes = `// ─── FTMO / MetaTrader 5 bridge ─────────────────────────────────────────────\napp.post('/api/internal/ftmo/validate', futuresRoute(PROVIDERS.FTMO, async (body, res) => {\n  logFuturesCall('ftmo', 'VALIDATE', body);\n  const validation = validateFtmoCredentials(process.env, body.credentials);\n  if (!validation.ok) {\n    return res.status(400).json({\n      ok: false,\n      provider: 'ftmo',\n      adapter: 'mt5_bridge',\n      validationStatus: 'invalid',\n      error: validation.error,\n      missing: validation.missing || [],\n    });\n  }\n  const client = buildFtmoClient({ credentials: body.credentials });\n  const result = await ftmoConnectivityCheck(client);\n  res.json({\n    ok: result?.ok !== false,\n    provider: 'ftmo',\n    adapter: 'mt5_bridge',\n    validationStatus: result?.ok === false ? 'invalid' : 'valid',\n    bridge: result,\n  });\n}));\n\napp.post('/api/internal/ftmo/diagnostics', futuresRoute(PROVIDERS.FTMO, async (body, res) => {\n  logFuturesCall('ftmo', 'DIAGNOSTICS', body);\n  const validation = validateFtmoCredentials(process.env, body.credentials);\n  if (!validation.ok) {\n    return res.status(400).json({\n      ok: false,\n      provider: 'ftmo',\n      adapter: 'mt5_bridge',\n      validationStatus: 'invalid',\n      error: validation.error,\n      missing: validation.missing || [],\n    });\n  }\n  const client = buildFtmoClient({ credentials: body.credentials });\n  const bridge = await ftmoConnectivityCheck(client);\n  res.json({\n    ok: bridge?.ok !== false,\n    validationStatus: bridge?.ok === false ? 'invalid' : 'valid',\n    ...getFtmoDiagnostics(client),\n    bridge,\n  });\n}));\n\napp.post('/api/internal/ftmo/status', futuresRoute(PROVIDERS.FTMO, async (body, res) => {\n  logFuturesCall('ftmo', 'STATUS', body);\n  const client = buildFtmoClient({ credentials: body.credentials });\n  const [accountResult, positionResult] = await Promise.all([\n    getFtmoAccountSummary(client),\n    getFtmoPositions(client),\n  ]);\n  res.json({\n    ok: true,\n    provider: 'ftmo',\n    adapter: 'mt5_bridge',\n    diagnostics: getFtmoDiagnostics(client),\n    account: accountResult?.account ?? accountResult,\n    positions: positionResult?.positions ?? positionResult?.items ?? [],\n  });\n}));\n\napp.post('/api/internal/ftmo/trade', futuresRoute(PROVIDERS.FTMO, async (body, res) => {\n  logFuturesCall('ftmo', 'TRADE', body);\n  const client = buildFtmoClient({ credentials: body.credentials });\n  const result = await placeFtmoOrder(client, body.order || {});\n  res.status(result?.ok === false ? 409 : 200).json(result);\n}));\n\napp.post('/api/internal/ftmo/close', futuresRoute(PROVIDERS.FTMO, async (body, res) => {\n  logFuturesCall('ftmo', 'CLOSE', body);\n  const client = buildFtmoClient({ credentials: body.credentials });\n  const result = await closeFtmoPosition(client, body.position || {});\n  res.status(result?.ok === false ? 409 : 200).json(result);\n}));\n\n`;
    if (updated.includes(anchor)) updated = updated.replace(anchor, `${routes}${anchor}`);
  }

  return updated;
});

patchFile('server/ftmoIndicesRouter.js', (source) => {
  let updated = source;
  if (!updated.includes("from './ftmoConnectionStore.js'")) {
    updated = updated.replace(
      "import { ftmoIndicesConfig } from './ftmoIndicesConfig.js';",
      "import { ftmoIndicesConfig } from './ftmoIndicesConfig.js';\nimport { getFtmoCredentials } from './ftmoConnectionStore.js';",
    );
  }

  updated = updated.replace(
    /const credentials = req\.body\?\.credentials \|\| null;\s*const client = buildFtmoClient\(\{ credentials \}\);/,
    `if (req.body?.credentials) {\n      return res.status(400).json({ ok: false, error: 'Client-supplied FTMO credentials are not accepted' });\n    }\n    const userId = req.user?.userId;\n    if (!userId) {\n      return res.status(401).json({ ok: false, error: 'Authenticated client login required' });\n    }\n    const credentials = await getFtmoCredentials(userId);\n    if (!credentials) {\n      return res.status(409).json({ ok: false, error: 'FTMO connection required for this client', code: 'FTMO_CONNECTION_REQUIRED' });\n    }\n    const client = buildFtmoClient({ credentials });`,
  );
  return updated;
});
