#!/usr/bin/env python3
"""Final, idempotent architecture pass for strategy-engine isolation.

This script runs after every V3 and PPR generator. It removes the retired legacy
scanner/decision engine and verifies that the independent V3 path cannot import,
consume, compare against, or fall through to ICT, PPR, or legacy strategy logic.
Shared OANDA market-data, broker transport, account risk, duplicate protection,
and order-state infrastructure remain intentionally common.
"""

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / 'server'


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding='utf-8')


def write(relative: str, body: str) -> None:
    (ROOT / relative).write_text(body, encoding='utf-8')


def remove_route(body: str, method: str, route: str) -> str:
    pattern = re.compile(
        rf"\napp\.{method}\('{re.escape(route)}'[\s\S]*?\n\}}\);\n",
        re.MULTILINE,
    )
    return pattern.sub('\n', body, count=1)


# ---------------------------------------------------------------------------
# V3 accepts and emits V3-native state only.
# ---------------------------------------------------------------------------
engine = read('server/v3Engine.js')
engine = engine.replace('  legacyDirection = null,\n', '')
engine = engine.replace('    legacyDirection,\n', '')
engine = re.sub(r"\n\s*directionAgrees:.*?,\n", '\n', engine)
write('server/v3Engine.js', engine)

scanner = read('server/v3IndependentScanner.js')
scanner = scanner.replace('        legacyDirection: null,\n', '')
scanner = scanner.replace('    legacyScannerUsed: false,\n', '')
scanner = scanner.replace('    legacyDirection: null,\n', '')
write('server/v3IndependentScanner.js', scanner)

auto = read('server/v3AutoTrade.js')
auto = auto.replace("import { executeTrade } from './oandaTrade.js';",
                    "import { executeV3Trade } from './v3TradeExecution.js';")
auto = auto.replace('const result = await executeTrade(signal, { client, autoAi: true });',
                    'const result = await executeV3Trade(signal, { client });')
auto = auto.replace('       legacyScannerUsed=false sharedRetraceWatchUsed=false',
                    '       foreignStrategyInputs=false')
auto = auto.replace(' legacyScannerUsed=false', ' foreignStrategyInputs=false')
for line in [
    '      legacyScannerUsed: false,\n',
    '      legacyDirection: null,\n',
    '      sharedRetraceWatchUsed: false,\n',
    '       legacyScannerUsed: false,\n',
    '       legacyDirection: null,\n',
    '       sharedRetraceWatchUsed: false,\n',
    '    legacyScannerUsed: false,\n',
    '    sharedRetraceWatchUsed: false,\n',
]:
    auto = auto.replace(line, '')
auto = re.sub(
    r"\n// June 23 soft-filter scoring remains exported[\s\S]*?\nexport function applyJune23SoftFilterScoring\([\s\S]*?\n\}\n?$",
    '\n',
    auto,
)
write('server/v3AutoTrade.js', auto)

dashboard = read('server/v3DashboardScan.js')
dashboard = dashboard.replace('legacy analysis', 'foreign-engine analysis')
dashboard = dashboard.replace('legacy-only timeframes', 'unavailable timeframes')
dashboard = dashboard.replace('legacy scanner signal, direction, confidence, promotion, or confirmation',
                              'foreign-engine signal, direction, confidence, promotion, or confirmation')
for line in [
    '    legacyScannerUsed: false,\n',
    '    legacyConfirmationsUsed: false,\n',
    '      legacyScannerUsed: false,\n',
    '      legacyConfirmationsUsed: false,\n',
]:
    dashboard = dashboard.replace(line, '')
write('server/v3DashboardScan.js', dashboard)

# ---------------------------------------------------------------------------
# Open V3 positions dispatch to V3-native analysis before any foreign waterfall.
# ---------------------------------------------------------------------------
monitor = read('server/oandaActiveTradeMonitor.js')
monitor_import = "import { analyzeV3OpenTrade } from './v3ActiveTradeMonitor.js';"
monitor_anchor = "import { computeLiveV3TpHitConfidence, isPureV3TradeRecord } from './v3TpConfidence.js';"
if monitor_import not in monitor:
    if monitor_anchor not in monitor:
        raise RuntimeError('V3 active monitor import anchor missing')
    monitor = monitor.replace(monitor_anchor, monitor_anchor + '\n' + monitor_import, 1)
monitor_early_marker = 'return analyzeV3OpenTrade(oandaTrade, { client, historyRecord, now: new Date() });'
if monitor_early_marker not in monitor:
    old = """  const takeProfit = oandaTrade.takeProfitOrder
    ? parseFloat(oandaTrade.takeProfitOrder.price)
    : null;

  // Live mid price for the instrument
"""
    new = """  const takeProfit = oandaTrade.takeProfitOrder
    ? parseFloat(oandaTrade.takeProfitOrder.price)
    : null;

  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));
  if (isPureV3TradeRecord(historyRecord || {})) {
    return analyzeV3OpenTrade(oandaTrade, { client, historyRecord, now: new Date() });
  }

  // Live mid price for the instrument
"""
    if old not in monitor:
        raise RuntimeError('V3 active monitor early-dispatch anchor missing')
    monitor = monitor.replace(old, new, 1)
monitor = monitor.replace(
    "  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));\n  const pureV3Trade = isPureV3TradeRecord(historyRecord || {});",
    "  const pureV3Trade = false; // V3 trades returned before foreign analysis",
    1,
)
write('server/oandaActiveTradeMonitor.js', monitor)

reassessor = read('server/oandaActiveTradeReassessor.js')
reassess_import = "import { reassessV3OpenTrade } from './v3ActiveTradeMonitor.js';"
reassess_anchor = "import { computeLiveV3TpHitConfidence, isPureV3TradeRecord } from './v3TpConfidence.js';"
if reassess_import not in reassessor:
    if reassess_anchor not in reassessor:
        raise RuntimeError('V3 active reassessor import anchor missing')
    reassessor = reassessor.replace(reassess_anchor, reassess_anchor + '\n' + reassess_import, 1)
reassess_early_marker = 'return reassessV3OpenTrade(oandaTrade, { client, historyRecord, now: new Date() });'
if reassess_early_marker not in reassessor:
    old = """  const currentTP = oandaTrade.takeProfitOrder
    ? parseFloat(oandaTrade.takeProfitOrder.price)
    : null;

  const pricing = (await getPricing([pair], { client }))[0];
"""
    new = """  const currentTP = oandaTrade.takeProfitOrder
    ? parseFloat(oandaTrade.takeProfitOrder.price)
    : null;

  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));
  if (isPureV3TradeRecord(historyRecord || {})) {
    return reassessV3OpenTrade(oandaTrade, { client, historyRecord, now: new Date() });
  }

  const pricing = (await getPricing([pair], { client }))[0];
"""
    if old not in reassessor:
        raise RuntimeError('V3 active reassessor early-dispatch anchor missing')
    reassessor = reassessor.replace(old, new, 1)
reassessor = reassessor.replace(
    "  const historyRecord = findTradeByBrokerOrderId(String(oandaTrade.id));\n  const entryContext = historyRecord ? {",
    "  const entryContext = historyRecord ? {",
    1,
)
reassessor = reassessor.replace(
    "  const pureV3Trade = isPureV3TradeRecord(historyRecord || entryContext);",
    "  const pureV3Trade = false; // V3 trades returned before foreign analysis",
    1,
)
write('server/oandaActiveTradeReassessor.js', reassessor)

# ---------------------------------------------------------------------------
# Remove the retired legacy scanner surface and V3/ICT comparison bridge.
# ---------------------------------------------------------------------------
index = read('server/index.js')
for import_line in [
    "import { scanForexPairs } from './oandaScanner.js';\n",
    "import { computeV3Comparisons } from './v3IctComparison.js';\n",
]:
    index = index.replace(import_line, '')

index = remove_route(index, 'get', '/api/oanda/scan')
index = remove_route(index, 'post', '/api/oanda/trade')
index = remove_route(index, 'post', '/api/internal/oanda/scan')

comparison = re.compile(
    r"\n\s*// DISPLAY-ONLY V3-vs-ICT comparison[\s\S]*?\n\s*\}\n\s*console\.log\(",
    re.MULTILINE,
)
index = comparison.sub('\n    console.log(', index, count=1)

# Retire the generic strategy-agnostic signal endpoint. Engine-specific manual
# and autonomous endpoints remain; no request can submit a legacy candidate.
index = remove_route(index, 'post', '/api/internal/oanda/trade')
write('server/index.js', index)

trade = read('server/oandaTrade.js')
trade = trade.replace("import { evaluateTradeCandidate } from './tradeDecisionEngine.js';\n", '')
write('server/oandaTrade.js', trade)

# The legacy engine is deleted, not feature-flagged.
for retired in [
    SERVER / 'oandaScanner.js',
    SERVER / 'tradeDecisionEngine.js',
    SERVER / 'v3IctComparison.js',
]:
    if retired.exists():
        retired.unlink()

# ---------------------------------------------------------------------------
# Fail the build if a generator or future edit reconnects the engines.
# ---------------------------------------------------------------------------
v3_files = [
    'server/v3Engine.js',
    'server/v3IndependentScanner.js',
    'server/v3AutoTrade.js',
    'server/v3DashboardScan.js',
    'server/v3QualityConfirmation.js',
    'server/v3ExecutionModel.js',
    'server/v3TradeExecution.js',
    'server/v3ActiveTradeMonitor.js',
]
forbidden_v3 = [
    "from './ict",
    "from \"./ict",
    "from './ppr",
    "from \"./ppr",
    'oandaScanner',
    'tradeDecisionEngine',
    'retraceWatchMode',
    'legacyDirection',
    'directionAgrees',
]

failures = []
for relative in v3_files:
    body = read(relative)
    for marker in forbidden_v3:
        if marker in body:
            failures.append(f'{relative}: forbidden foreign-engine marker {marker!r}')

for relative in [
    'server/oandaScanner.js',
    'server/tradeDecisionEngine.js',
    'server/v3IctComparison.js',
]:
    if (ROOT / relative).exists():
        failures.append(f'{relative}: retired file still exists')

index = read('server/index.js')
for marker in [
    "from './oandaScanner.js'",
    "from './v3IctComparison.js'",
    "app.get('/api/oanda/scan'",
    "app.post('/api/oanda/trade'",
    "app.post('/api/internal/oanda/scan'",
    "app.post('/api/internal/oanda/trade'",
    'computeV3Comparisons(',
]:
    if marker in index:
        failures.append(f'server/index.js: retired route/import remains {marker!r}')

router = read('server/autoAiRouter.js')
if "from './ictAutoScheduler.js'" in router:
    failures.append('server/autoAiRouter.js: V3 routing still depends on ICT scheduler')
if "from './autoAiWindow.js'" not in router:
    failures.append('server/autoAiRouter.js: missing engine-neutral execution window')

auto = read('server/v3AutoTrade.js')
if "from './v3TradeExecution.js'" not in auto or 'executeV3Trade(signal' not in auto:
    failures.append('server/v3AutoTrade.js: V3 does not use its dedicated execution boundary')
if "from './oandaTrade.js'" in auto or 'executeTrade(signal' in auto:
    failures.append('server/v3AutoTrade.js: direct shared executor access remains')

monitor = read('server/oandaActiveTradeMonitor.js')
if monitor.find('return analyzeV3OpenTrade(') > monitor.find('analyzeMacro('):
    failures.append('server/oandaActiveTradeMonitor.js: V3 dispatch occurs after foreign waterfall')
reassessor = read('server/oandaActiveTradeReassessor.js')
if reassessor.find('return reassessV3OpenTrade(') > reassessor.find('analyzeMacro('):
    failures.append('server/oandaActiveTradeReassessor.js: V3 dispatch occurs after foreign waterfall')

trade = read('server/oandaTrade.js')
if 'tradeDecisionEngine' in trade or 'evaluateTradeCandidate' in trade:
    failures.append('server/oandaTrade.js: legacy decision engine import/reference remains')

if failures:
    raise RuntimeError('Engine isolation enforcement failed:\n- ' + '\n- '.join(failures))

print('Engine isolation verified: V3, ICT and PPR are strategy-separated; legacy engine removed.')
