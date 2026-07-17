#!/usr/bin/env python3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MARKET_PATH = ROOT / 'server' / 'v3MarketMovement.js'
ENGINE_PATH = ROOT / 'server' / 'v3Engine.js'

market = MARKET_PATH.read_text(encoding='utf-8')
old_helper = """function triggerPrice(event = {}, fallback = null) {
  const values = [
    event.triggerPrice,
    event.reclaimClose,
    event.retestPrice,
    event.retestLevel,
    event.brokenLevel,
    event.close,
    event.sweptPriceLevel,
    fallback,
  ];
"""
new_helper = """function triggerPrice(event = null, fallback = null) {
  const source = event && typeof event === 'object' ? event : {};
  const values = [
    source.triggerPrice,
    source.reclaimClose,
    source.retestPrice,
    source.retestLevel,
    source.brokenLevel,
    source.close,
    source.sweptPriceLevel,
    fallback,
  ];
"""

if old_helper in market:
    market = market.replace(old_helper, new_helper, 1)
elif new_helper not in market:
    raise RuntimeError('Unable to locate triggerPrice helper in server/v3MarketMovement.js')

required_market = [
    'function triggerPrice(event = null, fallback = null)',
    "const source = event && typeof event === 'object' ? event : {};",
    'const eventPrice = triggerPrice(trigger, price);',
]
for marker in required_market:
    if marker not in market:
        raise RuntimeError(f'Null-trigger repair incomplete in v3MarketMovement.js: missing {marker}')

MARKET_PATH.write_text(market, encoding='utf-8')

engine = ENGINE_PATH.read_text(encoding='utf-8')
old_line = '  const earlyTrigger = marketMovement.triggerConfirmed === true;'
new_line = '  const earlyTrigger = marketMovement?.triggerConfirmed === true;'
if old_line in engine:
    engine = engine.replace(old_line, new_line, 1)
elif new_line not in engine:
    raise RuntimeError('Unable to locate earlyTrigger assignment in server/v3Engine.js')

if new_line not in engine:
    raise RuntimeError('Null-safe marketMovement guard was not applied in server/v3Engine.js')
ENGINE_PATH.write_text(engine, encoding='utf-8')

print('V3 market-movement null-trigger repair applied.')
