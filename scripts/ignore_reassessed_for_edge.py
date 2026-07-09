from pathlib import Path

p = Path("server/edgeIntelligence.js")
txt = p.read_text()

needle = """export function buildTradeEdgeSnapshot(trade) {
  if (!trade || typeof trade !== 'object') return null;
"""

replacement = """export function buildTradeEdgeSnapshot(trade) {
  if (!trade || typeof trade !== 'object') return null;

  const eventType = String(
    trade.status ||
    trade.event ||
    trade.event_type ||
    trade.type ||
    trade.action ||
    ''
  ).trim().toLowerCase();

  // Do not treat periodic active-trade reassessments as resolved trades.
  // They are unrealized snapshots. Edge Intelligence should study completed
  // open→close outcomes only.
  if (['reassessed', 'reassessment', 'updated', 'mark_to_market'].includes(eventType)) {
    return null;
  }
"""

if needle not in txt:
    raise SystemExit("Could not patch buildTradeEdgeSnapshot start; inspect server/edgeIntelligence.js manually.")

txt = txt.replace(needle, replacement)
p.write_text(txt)
print("Edge now ignores REASSESSED snapshots")
