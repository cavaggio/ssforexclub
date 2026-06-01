/**
 * web/components/ai-trade-intelligence-panel.tsx
 *
 * Signal Stack V3 — AI Trade Intelligence Panel.
 *
 * Synthesises the strategy-attribution report into a plain-language trading
 * briefing: an overall verdict, where the edge is strongest, where it leaks,
 * and concrete "do / avoid" guidance. The synthesis is deterministic (derived
 * from the user's own trade history) so it needs no external API key and can't
 * fabricate numbers — every claim traces back to the report it is given.
 *
 * Presentational only. It renders intelligence; it never places or changes a
 * trade.
 */

'use client';

import type { AttributionReport, GroupSummary } from '@/lib/edgeAnalytics';

function verdict(report: AttributionReport): { tone: 'good' | 'warn' | 'bad' | 'neutral'; line: string } {
  const wr = report.overall.winRate;
  const pnl = report.overall.totalPnl;
  if (!report.sampleSufficient || wr == null) {
    return { tone: 'neutral', line: 'Not enough resolved trades yet to judge the edge — keep logging closes.' };
  }
  if (wr >= 55 && (pnl ?? 0) >= 0) return { tone: 'good', line: `Edge is positive: ${wr}% win rate across ${report.overall.resolved} resolved trades.` };
  if (wr >= 45) return { tone: 'warn', line: `Edge is marginal: ${wr}% win rate — profitability hinges on which conditions you trade.` };
  return { tone: 'bad', line: `Edge is negative right now: ${wr}% win rate over ${report.overall.resolved} resolved trades — tighten conditions before sizing up.` };
}

function describe(g: GroupSummary | undefined): string | null {
  if (!g) return null;
  const wr = g.winRate != null ? `${g.winRate}% win` : 'n/a';
  const pnl = g.avgPnl != null ? ` · avg ${g.avgPnl >= 0 ? '+' : ''}${g.avgPnl}` : '';
  return `${g.key} — ${wr}${pnl} (n=${g.trades})`;
}

export function AITradeIntelligencePanel({ report }: { report: AttributionReport }) {
  const v = verdict(report);
  const toneColor =
    v.tone === 'good' ? 'var(--good)' : v.tone === 'bad' ? 'var(--bad)' : v.tone === 'warn' ? 'var(--warn)' : 'var(--accent)';

  const e = report.edge;
  const dos: string[] = [];
  const donts: string[] = [];
  const bestPair = describe(e.bestPairs[0]);
  const bestSession = describe(e.bestSessions[0]);
  const bestRegime = describe(e.bestRegimes[0]);
  const bestCond = describe(e.bestConditions[0]);
  const worstPair = describe(e.worstPairs[0]);
  const worstSession = describe(e.worstSessions[0]);
  const worstRegime = describe(e.worstRegimes[0]);
  const worstCond = describe(e.worstConditions[0]);

  if (bestPair) dos.push(`Lean into ${bestPair}.`);
  if (bestSession) dos.push(`Favour the ${bestSession} session.`);
  if (bestRegime) dos.push(`Strongest in regime ${bestRegime}.`);
  if (bestCond) dos.push(`Best condition: ${bestCond}.`);
  if (worstPair && worstPair !== bestPair) donts.push(`Be cautious on ${worstPair}.`);
  if (worstSession && worstSession !== bestSession) donts.push(`Underperforms in ${worstSession}.`);
  if (worstRegime && worstRegime !== bestRegime) donts.push(`Weakest in regime ${worstRegime}.`);
  if (worstCond && worstCond !== bestCond) donts.push(`Edge leak: ${worstCond}.`);

  return (
    <section
      style={{
        background: 'linear-gradient(180deg, rgba(77,184,255,0.06), var(--panel))',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 18 }}>🧠</span>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, letterSpacing: 0.3 }}>AI Trade Intelligence</h2>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--muted)' }}>
          {report.overall.resolved}/{report.overall.trades} resolved
        </span>
      </div>

      <div
        style={{
          borderLeft: `3px solid ${toneColor}`,
          paddingLeft: 12,
          marginBottom: 16,
          fontSize: 14,
          color: toneColor,
          fontWeight: 700,
        }}
      >
        {v.line}
      </div>

      {report.highlights.length > 0 && (
        <ul style={{ margin: '0 0 16px', paddingLeft: 18, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.7 }}>
          {report.highlights.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Guidance title="✅ Do more of" items={dos} empty="Need more resolved trades to identify strengths." accent="var(--good)" />
        <Guidance title="⚠️ Avoid / watch" items={donts} empty="No clear edge leaks yet." accent="var(--warn)" />
      </div>

      <p style={{ marginTop: 14, marginBottom: 0, fontSize: 10.5, color: 'var(--muted)' }}>
        Synthesised from your trade history (min {report.minSamples} samples/group). Informational only — not trade advice and not wired into execution.
      </p>
    </section>
  );
}

function Guidance({ title, items, empty, accent }: { title: string; items: string[]; empty: string; accent: string }) {
  return (
    <div style={{ background: 'rgba(0,0,0,0.25)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: accent, marginBottom: 8 }}>{title}</div>
      {items.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--muted)' }}>{empty}</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, lineHeight: 1.6 }}>
          {items.map((it, i) => (
            <li key={i}>{it}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
