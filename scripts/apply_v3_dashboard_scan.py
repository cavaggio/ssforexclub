#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / 'server' / 'index.js'

text = PATH.read_text(encoding='utf-8')

import_line = "import { runV3DashboardScan } from './v3DashboardScan.js';"
import_anchor = "import { scanForexPairs } from './oandaScanner.js';"
if import_line not in text:
    if import_anchor not in text:
        raise RuntimeError('V3 dashboard scan import anchor not found in server/index.js')
    text = text.replace(import_anchor, f"{import_anchor}\n{import_line}", 1)

route_marker = "app.post('/api/internal/oanda/v3-scan'"
if route_marker not in text:
    legacy_route = """// POST /api/internal/oanda/scan
app.post('/api/internal/oanda/scan', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('SCAN', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => scanForexPairs(req.body?.pairs || null, { client }),
    );
    console.log(
      `[INTERNAL SCAN] complete accountId=${maskAccountId(client.accountId)} ` +
        `qualified=${result?.qualified?.length ?? 0} rejected=${result?.rejected?.length ?? 0}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_SCAN] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});
"""

    native_route = """

// POST /api/internal/oanda/v3-scan
// Dashboard-only native V3 analysis. This route reads raw user-scoped OANDA
// pricing/candles and evaluates Stage 1 followed by Stage 2. It never consumes
// legacy scanner candidates, confidence, direction, promotion, or confirmations.
app.post('/api/internal/oanda/v3-scan', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  assertClientMatchesRequest(client, req.body);
  logInternalCall('V3_SCAN', req.body);
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => runV3DashboardScan({
        client,
        pairs: req.body?.pairs || null,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL V3_SCAN] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
    );
    console.log(
      `[INTERNAL V3_SCAN] complete accountId=${maskAccountId(client.accountId)} ` +
        `scanner=v3_independent legacyScannerUsed=false legacyConfirmationsUsed=false ` +
        `qualified=${result?.qualified?.length ?? 0} ` +
        `near=${result?.nearQualified?.length ?? 0} ` +
        `hot=${result?.hotWatch?.length ?? 0} ` +
        `rejected=${result?.rejected?.length ?? 0}`,
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_V3_SCAN] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});
"""

    if legacy_route not in text:
        raise RuntimeError('Legacy internal OANDA scan route anchor not found in server/index.js')
    text = text.replace(legacy_route, legacy_route + native_route, 1)

required = [
    import_line,
    "app.post('/api/internal/oanda/v3-scan'",
    'runV3DashboardScan({',
    'scanner=v3_independent legacyScannerUsed=false legacyConfirmationsUsed=false',
]
missing = [marker for marker in required if marker not in text]
if missing:
    raise RuntimeError('V3 dashboard scan patch incomplete: ' + ', '.join(missing))

PATH.write_text(text, encoding='utf-8')
print('Native V3 dashboard scan route applied.')
