#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX_PATH = ROOT / 'server' / 'index.js'

text = INDEX_PATH.read_text(encoding='utf-8')

import_line = "import { executeRecentQualifiedV3Signal } from './v3ManualExecution.js';"
import_anchor = "import { runUserScoped } from './requestContext.js';"
if import_line not in text:
    if import_anchor not in text:
        raise RuntimeError('Recent Signals execution import anchor not found')
    text = text.replace(import_anchor, f"{import_anchor}\n{import_line}", 1)

old_call = """      () => executeTrade(signal, { client }),
"""
new_call = """      () => executeRecentQualifiedV3Signal({
        signal,
        client,
        now: new Date(),
        log: (message) => console.log(
          `[INTERNAL V3 RECENT SIGNAL] accountId=${maskAccountId(client.accountId)} ${message}`,
        ),
      }),
"""
if old_call in text:
    text = text.replace(old_call, new_call, 1)
elif new_call not in text:
    raise RuntimeError('Internal OANDA trade execution call anchor not found')

old_comment = """//   Builds a per-request OANDA client from the supplied credentials and calls
//   executeTrade with the user's signal. The signal's `environment` is forced
"""
new_comment = """//   Builds a per-request OANDA client from the supplied credentials, verifies
//   that the Recent Signals card contains completed native V3 Stage 1/Stage 2,
//   refreshes the exact pair from current OANDA data, and only then calls the
//   broker executor. The signal's `environment` is forced
"""
if old_comment in text:
    text = text.replace(old_comment, new_comment, 1)

required = [
    import_line,
    'executeRecentQualifiedV3Signal({',
    '[INTERNAL V3 RECENT SIGNAL]',
]
for marker in required:
    if marker not in text:
        raise RuntimeError(f'Recent Signals V3 execution patch incomplete: missing {marker}')

INDEX_PATH.write_text(text, encoding='utf-8')
print('Recent Signals native V3 manual execution route applied.')
