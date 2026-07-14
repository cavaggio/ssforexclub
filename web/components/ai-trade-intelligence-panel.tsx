/**
 * Signal Stack V3 — AI Trade Intelligence Panel.
 *
 * Deterministic synthesis from the user's connected Trade Activity history.
 */

'use client';

import type { AttributionReport, GroupSummary } from '@/lib/edgeAnalytics';

function verdict(report: AttributionReport): { tone: 'good' | 'warn' | 'bad' | 'neutral'; line: string } {
  const winRate = report.overall.winRate;
  const pnl = report.overall.totalPnl;
  if (!report.sampleSufficient || winRate == null) {
    return {
      tone: 'neutral',
      line: `Trade Activity is connected: ${report.overall.resolved} closed trade(s), ${report.overall.outcomes} with a known P/L outcome. More scored outcomes are needed to judge the edge.`,
    };
  }
  if (winRate >= 55 && (pnl ?? 0) >= 0) {
    return { tone: 'good', line: `Edge is positive: ${winRate}% win rate across ${report.overall.outcomes} scored outcomes.` };
  }
  if (winRate >= 45) {
    return { tone: 'warn', line: `Edge is marginal: ${winRate}% win rate — profitability hinges on which conditions you trade.` };
  }
  return {
    tone: 'bad',
    line: `Edge is negative right now: ${winRate}% win rate over ${report.overall.outcomes} scored outcomes — tighten conditions before sizing up.`,
  };
}

function describe(group: GroupSummary | undefined): string | null {
  if (!group) return null;
  const winRate = group.winRate != null ? `${group.winRate}% win` : 'n/a';
  const pnl = group.avgPnl != null ? ` · avg ${group.avgPnl >= 0 ? '+' : ''}${group.avgPnl}` : '';
  return `${group.key} — ${winRate}${pnl} (n=${group.trades})`;
}

export function AITradeIntelligencePanel({ report }: { report: AttributionReport }) {
  const currentVerdict = verdict(report);
  const toneColor =
    currentVerdict.tone === 'good'
      ? 'var(--good)'
      : currentVerdict.tone === 'bad'
        ? 'var(--bad)'
        : currentVerdict.tone === 'warn'
          ? 'var(--warn)'
          : 'var(--accent)';

  const edge = report.edge;
  const dos: string[] = [];
  const donts: string[] = [];
  const bestPair = describe(edge.bestPairs[0]);
  const bestSession = describe(edge.bestSessions[0]);
  const bestRegime = describe(edge.bestRegimes[0]);
  const bestCondition = describe(edge.bestConditions[0]);
  const worstPair = describe(edge.worstPairs[0]);
  const worstSession = describe(edge.worstSessions[0]);
  const worstRegime = describe(edge.worstRegimes[0]);
  const worstCondition = describe(edge.worstConditions[0]);

  if (bestPair) dos.push(`Lean into ${bestPair}.`);
  if (bestSession) dos.push(`Favour the ${bestSession} session.`);
  if (bestRegime) dos.push(`Strongest in regime ${bestRegime}.`);
  if (bestCondition) dos.push(`Best condition: ${bestCondition}.`);
  if (worstPair && worstPair !== bestPair) donts.push(`Be cautious on ${worstPair}.`);
  if (worstSession && worstSession !== bestSession) donts.push(`Underperforms in ${worstSession}.`);
  if (worstRegime && worstRegime !== bestRegime) donts.push(`Weakest in regime ${worstRegime}.`);
  if (worstCondition && worstCondition !== bestCondition) donts.push(`Edge leak: ${worstCondition}.`);

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
          {report.overall.resolved}/{report.overall.trades} closed · {report.overall.outcomes} scored
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
        {currentVerdict.line}
      </div>

      {report.highlights.length > 0 && (
        <ul style={{ margin: '0 0 16px', paddingLeft: 18, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.7 }}>
          {report.highlights.map((highlight, index) => <li key={index}>{highlight}</li>)}
        </ul>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Guidance title="✅ Do more of" items={dos} empty="Need more scored outcomes to identify strengths." accent="var(--good)" />
        <Guidance title="⚠️ Avoid / watch" items={donts} empty="No clear edge leaks yet." accent="var(--warn)" />
      </div>

      <p style={{ marginTop: 14, marginBottom: 0, fontSize: 10.5, color: 'var(--muted)' }}>
        Synthesised from connected Trade Activity history (minimum {report.minSamples} scored outcomes per group). Informational only — not trade advice and not wired into execution.
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
          {items.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      )}
    </div>
  );
}
