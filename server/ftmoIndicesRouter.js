import express from 'express';
import { buildFtmoClient } from './ftmoClient.js';
import { analyzeFtmoIndexSetup } from './ftmoIndicesEngine.js';
import { executeFtmoIndexSetup } from './ftmoIndicesExecution.js';
import { ftmoIndicesConfig } from './ftmoIndicesConfig.js';
import { getFtmoCredentials } from './ftmoConnectionStore.js';

const router = express.Router();

router.get('/status', (_req, res) => {
  const config = ftmoIndicesConfig();
  res.json({
    ok: true,
    engine: config.engineId,
    mode: config.mode,
    enabled: config.enabled,
    autoTradeEnabled: config.autoTradeEnabled,
    liveExecutionEnabled: config.liveExecutionEnabled,
    symbols: config.symbols,
    primarySymbol: config.primarySymbol,
    failClosed: true,
  });
});

router.post('/scan', async (req, res) => {
  try {
    const setup = analyzeFtmoIndexSetup(req.body || {});
    res.json({ ok: true, setup });
  } catch (error) {
    res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/execute', async (req, res) => {
  try {
    if (req.body?.credentials) {
      return res.status(400).json({ ok: false, error: 'Client-supplied FTMO credentials are not accepted' });
    }

    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ ok: false, error: 'Authenticated client login required' });
    }

    const credentials = await getFtmoCredentials(userId);
    if (!credentials) {
      return res.status(409).json({
        ok: false,
        error: 'FTMO connection required for this client',
        code: 'FTMO_CONNECTION_REQUIRED',
      });
    }

    const client = buildFtmoClient({ credentials });
    const result = await executeFtmoIndexSetup({ client, setupInput: req.body?.setup || req.body || {} });
    return res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    return res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
