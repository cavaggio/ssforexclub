import { getServerSupabase } from '@/lib/db';

type DecisionRow = {
  broker_account_id: string;
  pair: string;
  direction: string | null;
  signal_id: string;
  decision_stage: string;
  observed_at: string;
  grade: string;
  score: number;
  threshold: number;
  passed: boolean;
  exhaustion_risk_score: number | null;
  blockers: unknown;
  executed: boolean;
  broker_trade_id: string | null;
};

type LifecycleRow = {
  broker_account_id: string | null;
  candidate_signal_id: string | null;
  broker_trade_id: string | null;
  realized_r: number | null;
  result: string | null;
  opened_at: string | null;
  closed_at: string | null;
};

function asNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function blockersOf(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function shortAccount(accountId: string) {
  if (!accountId) return 'Unknown account';
  if (accountId.length <= 8) return accountId;
  return `${accountId.slice(0, 4)}…${accountId.slice(-4)}`;
}

const card: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 16,
};

export async function IctAGradePrecisionPanel({ userId }: { userId: string }) {
  const supabase = getServerSupabase();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: decisionData, error: decisionError }, { data: lifecycleData }] = await Promise.all([
    supabase
      .from('ict_a_grade_decisions')
      .select('broker_account_id,pair,direction,signal_id,decision_stage,observed_at,grade,score,threshold,passed,exhaustion_risk_score,blockers,executed,broker_trade_id')
      .eq('user_id', userId)
      .gte('observed_at', since)
      .order('observed_at', { ascending: false })
      .limit(1000),
    supabase
      .from('actual_trade_lifecycles')
      .select('broker_account_id,candidate_signal_id,broker_trade_id,realized_r,result,opened_at,closed_at')
      .eq('user_id', userId)
      .eq('engine', 'ict')
      .gte('opened_at', since)
      .order('opened_at', { ascending: false })
      .limit(500),
  ]);

  if (decisionError) {
    return (
      <section style={card}>
        <h2 style={{ margin: 0, fontSize: 16 }}>ICT A-Grade Precision</h2>
        <p style={{ margin: '8px 0 0', color: 'var(--warn)', fontSize: 12 }}>
          A-grade audit data is not available yet: {decisionError.message}
        </p>
      </section>
    );
  }

  const decisions = (decisionData ?? []) as DecisionRow[];
  const lifecycles = (lifecycleData ?? []) as LifecycleRow[];
  const lifecycleBySignal = new Map<string, LifecycleRow>();
  const lifecycleByTrade = new Map<string, LifecycleRow>();
  for (const row of lifecycles) {
    if (row.candidate_signal_id) lifecycleBySignal.set(row.candidate_signal_id, row);
    if (row.broker_trade_id) lifecycleByTrade.set(row.broker_trade_id, row);
  }

  const accountIds = [...new Set(decisions.map((row) => row.broker_account_id).filter(Boolean))];
  const latest = decisions[0] ?? null;

  return (
    <section style={{ ...card, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16 }}>ICT A-Grade Precision</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--muted)', fontSize: 12, maxWidth: 760 }}>
            Prospective quality tracking for setups that pass the new A-grade gate. A score of 80+ is a setup-quality threshold, not an 80% predicted win probability. Realized precision is calculated only from closed broker outcomes after this gate is active.
          </p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>Required setup score</div>
          <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--accent)' }}>80+</div>
        </div>
      </div>

      {decisions.length === 0 ? (
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>
          No post-deployment A-grade decisions have been recorded yet. This panel will populate from new ICT scans and executions; historical trades are intentionally not back-labeled as A-grade.
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10 }}>
            {accountIds.map((accountId) => {
              const rows = decisions.filter((row) => row.broker_account_id === accountId);
              const scannerRows = rows.filter((row) => row.decision_stage === 'scanner');
              const passedScanner = scannerRows.filter((row) => row.passed);
              const executedRows = rows.filter((row) => row.decision_stage === 'executed' && row.executed && row.passed);
              const resolved = executedRows
                .map((row) => lifecycleByTrade.get(row.broker_trade_id || '') || lifecycleBySignal.get(row.signal_id))
                .filter((row): row is LifecycleRow => Boolean(row && asNumber(row.realized_r) != null));
              const wins = resolved.filter((row) => Number(row.realized_r) > 0).length;
              const losses = resolved.filter((row) => Number(row.realized_r) < 0).length;
              const scored = wins + losses;
              const realizedPrecision = scored > 0 ? Math.round((wins / scored) * 1000) / 10 : null;
              const averageScore = passedScanner.length
                ? passedScanner.reduce((sum, row) => sum + Number(row.score || 0), 0) / passedScanner.length
                : null;
              const averageExhaustion = passedScanner.length
                ? passedScanner.reduce((sum, row) => sum + Number(row.exhaustion_risk_score || 0), 0) / passedScanner.length
                : null;

              return (
                <div key={accountId} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase' }}>{shortAccount(accountId)}</div>
                  <div style={{ marginTop: 7, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    <Metric label="A-grade scans" value={String(passedScanner.length)} />
                    <Metric label="Executed" value={String(executedRows.length)} />
                    <Metric label="Resolved" value={String(scored)} />
                    <Metric
                      label="Realized precision"
                      value={realizedPrecision == null ? '—' : `${realizedPrecision}%`}
                      emphasis={realizedPrecision != null && realizedPrecision >= 80}
                    />
                    <Metric label="Avg A-score" value={averageScore == null ? '—' : averageScore.toFixed(1)} />
                    <Metric label="Avg exhaustion" value={averageExhaustion == null ? '—' : averageExhaustion.toFixed(1)} />
                  </div>
                  <div style={{ marginTop: 8, fontSize: 11, color: scored >= 20 ? 'var(--muted)' : 'var(--warn)' }}>
                    {scored >= 20
                      ? `${wins} wins / ${losses} losses in the prospective A-grade sample.`
                      : `${wins} wins / ${losses} losses · early sample; target evaluation becomes more meaningful at 20+ resolved A-grade trades.`}
                  </div>
                </div>
              );
            })}
          </div>

          {latest && (
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, fontSize: 12 }}>
              <strong>Latest decision:</strong>{' '}
              {latest.pair.replace('_', '/')} {latest.direction?.toUpperCase() ?? ''} · {latest.decision_stage.replace('_', ' ')} · score {Number(latest.score).toFixed(0)}/{Number(latest.threshold).toFixed(0)} · exhaustion {latest.exhaustion_risk_score == null ? '—' : Number(latest.exhaustion_risk_score).toFixed(0)} · {latest.passed ? 'A-grade pass' : 'rejected'}
              {!latest.passed && blockersOf(latest.blockers).length > 0 && (
                <div style={{ marginTop: 4, color: 'var(--warn)' }}>{blockersOf(latest.blockers).join(' · ')}</div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 17, fontWeight: 850, color: emphasis ? 'var(--good)' : 'var(--text)' }}>{value}</div>
    </div>
  );
}
