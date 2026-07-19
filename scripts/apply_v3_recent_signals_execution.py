#!/usr/bin/env python3
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / 'server' / 'index.js'

text = INDEX_PATH.read_text(encoding='utf-8')

import_line = "import { executeRecentQualifiedV3Signal } from './v3ManualExecution.js';"
import_anchor = "import { runUserScoped } from './requestContext.js';"
if import_line not in text:
    if import_anchor not in text:
        raise RuntimeError('Recent Signals execution import anchor not found')
    text = text.replace(import_anchor, f"{import_anchor}\n{import_line}", 1)

route_marker = "app.post('/api/internal/oanda/v3-trade'"
if route_marker not in text:
    route_anchor = "// ══════════════════════════════════════════════════════════════════════════════\n\n// API guard"
    route = """// POST /api/internal/oanda/v3-trade
//   V3-only manual execution for a completed Recent Signals candidate.
//   The exact pair is refreshed from raw OANDA data and must pass current native
//   V3 Stage 1, Stage 2, direction-lock, and geometry checks before broker handoff.
app.post('/api/internal/oanda/v3-trade', async (req, res) => {
  if (!requireInternalAuth(req, res)) return;
  const client = buildClientFromBody(req.body, res);
  if (!client) return;
  const signal = req.body?.signal;
  if (!signal || typeof signal !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing V3 signal in body' });
    return;
  }
  if (!signal.pair || typeof signal.pair !== 'string') {
    res.status(400).json({ ok: false, error: 'Invalid V3 signal.pair' });
    return;
  }
  if (signal.direction !== 'long' && signal.direction !== 'short') {
    res.status(400).json({ ok: false, error: 'Invalid V3 signal.direction (must be long or short)' });
    return;
  }
  const env = String(req.body?.environment ?? '').toLowerCase();
  if (!isExecutableEnvironment(env)) {
    res.status(400).json({
      ok: false,
      error: `V3 trade endpoint requires environment=live|practice|paper (got "${env || '<empty>'}")`,
    });
    return;
  }
  assertClientMatchesRequest(client, req.body);
  logInternalCall('V3_TRADE', req.body);
  signal.environment = env;
  try {
    const result = await runUserScoped(
      { accountId: client.accountId, environment: client.environment },
      () => executeRecentQualifiedV3Signal({
        signal,
        client,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL V3 RECENT SIGNAL] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
    );
    res.json(result);
  } catch (err) {
    console.error('[INTERNAL_V3_TRADE] error:', err?.message || err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

// ══════════════════════════════════════════════════════════════════════════════

// API guard"""
    if route_anchor not in text:
        raise RuntimeError('V3 manual execution route anchor not found')
    text = text.replace(route_anchor, route, 1)

# The generic strategy-agnostic endpoint is retired by the final isolation pass.
# On subsequent generator runs, remove its now-dangling documentation block.
if "app.post('/api/internal/oanda/trade'" not in text:
    text = re.sub(
        r"\n// POST /api/internal/oanda/trade[\s\S]*?(?=\n// POST /api/internal/oanda/v3-trade|\n// ═)",
        '\n',
        text,
        count=1,
    )

required = [
    import_line,
    route_marker,
    'executeRecentQualifiedV3Signal({',
    '[INTERNAL V3 RECENT SIGNAL]',
]
for marker in required:
    if marker not in text:
        raise RuntimeError(f'Recent Signals V3 execution patch incomplete: missing {marker}')

INDEX_PATH.write_text(text, encoding='utf-8')
print('Recent Signals V3-only manual execution route applied.')
