'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Summary = {
  engine: string;
  pair: string;
  outcomes: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  expectancy_r: number | null;
  profit_factor: number | null;
  avg_mfe_r: number | null;
  avg_mae_r: number | null;
};

type TimeStat = {
  engine: string;
  pair: string;
  direction: string | null;
  session: string | null;
  time_bucket_15m: string;
  outcomes: number;
  win_rate: number | null;
  expectancy_r: number | null;
  profit_factor: number | null;
};

type ConfirmationStat = {
  engine: string;
  pair: string;
  confirmation: string;
  outcomes: number;
  win_rate: number | null;
  expectancy_r: number | null;
  expectancy_lift_r: number | null;
};

type Playbook = {
  id: string;
  engine: string;
  pair: string;
  version: number;
  status: string;
  recommendation_stage: string;
  sample_size: number;
  win_rate: number | null;
  expectancy_r: number | null;
  profit_factor: number | null;
  preferred_scalp_windows: Array<Record<string, unknown>>;
  valuable_confirmations: Array<Record<string, unknown>>;
  weak_confirmations: Array<Record<string, unknown>>;
  ai_summary: Record<string, unknown>;
  validator: Record<string, unknown>;
};

type Dashboard = {
  playbooks: Playbook[];
  summaries: Summary[];
  timeStats: TimeStat[];
  confirmationStats: ConfirmationStat[];
  safeguards: {
    mode: string;
    liveThresholdsChanged: boolean;
    maxConfidenceAdjustment: number;
  };
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; migrationRequired: boolean }
  | { kind: 'ready'; data: Dashboard; refreshing: boolean };

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function displayPair(value: string) {
  return String(value || '').replace('_', '/');
}

function label(value: unknown) {
  return String(value || '—').replaceAll('_', ' ');
}

function rValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${parsed >= 0 ? '+' : ''}${parsed.toFixed(2)}R` : '—';
}

export function SignalLearningPanel() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async (preserve = false) => {
    if (!preserve) setState({ kind: 'loading' });
    try {
      const response = await fetch('/api/edge-intelligence/learning', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        setState({
          kind: 'error',
          message: payload?.error || `HTTP ${response.status}`,
          migrationRequired: payload?.migrationRequired === true,
        });
        return;
      }
      setState({
        kind: 'ready',
        refreshing: false,
        data: {
          playbooks: Array.isArray(payload.playbooks) ? payload.playbooks : [],
          summaries: Array.isArray(payload.summaries) ? payload.summaries : [],
          timeStats: Array.isArray(payload.timeStats) ? payload.timeStats : [],
          confirmationStats: Array.isArray(payload.confirmationStats) ? payload.confirmationStats : [],
          safeguards: payload.safeguards || {
            mode: 'display_and_shadow_only',
            liveThresholdsChanged: false,
            maxConfidenceAdjustment: 0,
          },
        },
      });
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        migrationRequired: false,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshPlaybooks = useCallback(async () => {
    if (state.kind !== 'ready') return;
    setState({ ...state, refreshing: true });
    try {
      const response = await fetch('/api/edge-intelligence/learning', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) {
        setState({
          kind: 'error',
          message: payload?.error || 'Pair playbook refresh failed.',
          migrationRequired: payload?.migrationRequired === true,
        });
        return;
      }
      await load(true);
    } catch (error) {
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        migrationRequired: false,
      });
    }
  }, [load, state]);

  if (state.kind === 'loading') {
    return <section style={card}><p style={muted}>Loading signal learning…</p></section>;
  }

  if (state.kind === 'error') {
    return (
      <section style={card}>
        <h2 style={heading}>Pair-specific signal learning</h2>
        <p style={{ ...muted, color: 'var(--bad)' }}>{state.message}</p>
        {state.migrationRequired && (
          <p style={{ ...muted, color: 'var(--warn)' }}>
            Apply migration <code>20260727210000_signal_learning_pipeline.sql</code> to the production Supabase project, then redeploy.
          </p>
        )}
        <button style={button} onClick={() => void load()}>Retry</button>
      </section>
    );
  }

  const data = state.data;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div>
          <h2 style={heading}>Pair-specific signal learning</h2>
          <p style={{ ...muted, marginTop: 4 }}>
            Forward-graded scans, scalp timing, confirmation lift, and versioned AI playbooks for each broker account and engine.
          </p>
        </div>
        <button style={button} disabled={state.refreshing} onClick={() => void refreshPlaybooks()}>
          {state.refreshing ? 'Refreshing…' : 'Refresh playbooks'}
        </button>
      </div>

      <SafetyBanner safeguards={data.safeguards} />
      <PairExpectancyChart rows={data.summaries} />
      <div style={grid}>
        <TimeWindowChart rows={data.timeStats} />
        <ConfirmationLiftChart rows={data.confirmationStats} />
      </div>
      <PlaybookGrid playbooks={data.playbooks} />
    </section>
  );
}

function SafetyBanner({ safeguards }: { safeguards: Dashboard['safeguards'] }) {
  return (
    <div style={{
      border: '1px solid #38506a',
      borderRadius: 10,
      background: 'rgba(77,184,255,0.06)',
      padding: '10px 13px',
      fontSize: 12,
      color: 'var(--muted)',
    }}>
      <strong style={{ color: 'var(--accent)' }}>Learning mode: {label(safeguards.mode)}</strong>
      {' · '}Live thresholds changed: <strong style={{ color: safeguards.liveThresholdsChanged ? 'var(--bad)' : 'var(--good)' }}>
        {safeguards.liveThresholdsChanged ? 'Yes' : 'No'}
      </strong>
      {' · '}Confidence influence: {rValue(safeguards.maxConfidenceAdjustment).replace('R', ' points')}
    </div>
  );
}

function PairExpectancyChart({ rows }: { rows: Summary[] }) {
  const ranked = useMemo(
    () => [...rows].sort((a, b) => number(b.expectancy_r) - number(a.expectancy_r)).slice(0, 16),
    [rows],
  );
  const maximum = Math.max(0.1, ...ranked.map((row) => Math.abs(number(row.expectancy_r))));
  return (
    <section style={card}>
      <Title title="Pair expectancy" description="Average 60-minute R outcome for every graded observation, not only executed trades." />
      {ranked.length === 0 ? <Empty /> : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ranked.map((row) => {
            const expectancy = number(row.expectancy_r);
            return (
              <div key={`${row.engine}-${row.pair}`} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 150px', gap: 10, alignItems: 'center' }}>
                <div style={{ fontSize: 12, fontWeight: 800 }}>
                  {displayPair(row.pair)} <span style={engineBadge}>{row.engine.toUpperCase()}</span>
                </div>
                <div style={track} aria-label={`${displayPair(row.pair)} expectancy ${expectancy.toFixed(2)} R`}>
                  <div style={{
                    height: '100%',
                    width: `${Math.max(2, Math.abs(expectancy) / maximum * 100)}%`,
                    marginLeft: expectancy < 0 ? 'auto' : 0,
                    borderRadius: 4,
                    background: expectancy >= 0 ? 'var(--good)' : 'var(--bad)',
                    opacity: 0.75,
                  }} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
                  <strong style={{ color: expectancy >= 0 ? 'var(--good)' : 'var(--bad)' }}>{rValue(expectancy)}</strong>
                  {' · '}{row.win_rate == null ? '—' : `${row.win_rate}%`} win · n{row.outcomes}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function TimeWindowChart({ rows }: { rows: TimeStat[] }) {
  const ranked = useMemo(
    () => [...rows]
      .filter((row) => number(row.outcomes) >= 3)
      .sort((a, b) => number(b.expectancy_r) - number(a.expectancy_r))
      .slice(0, 12),
    [rows],
  );
  const maximum = Math.max(0.1, ...ranked.map((row) => Math.max(0, number(row.expectancy_r))));
  return (
    <section style={card}>
      <Title title="Best scalp windows" description="New York time buckets ranked by forward expectancy." />
      {ranked.length === 0 ? <Empty /> : ranked.map((row) => (
        <div key={`${row.engine}-${row.pair}-${row.direction}-${row.time_bucket_15m}`} style={{ marginBottom: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, marginBottom: 4 }}>
            <span style={{ fontWeight: 800 }}>{displayPair(row.pair)} · {row.time_bucket_15m} ET</span>
            <span style={{ color: 'var(--muted)' }}>{label(row.session)} · {label(row.direction)} · n{row.outcomes}</span>
          </div>
          <div style={track}>
            <div style={{ height: '100%', width: `${Math.max(2, number(row.expectancy_r) / maximum * 100)}%`, background: 'var(--accent)', borderRadius: 4, opacity: 0.75 }} />
          </div>
          <div style={{ marginTop: 3, fontSize: 10, color: 'var(--muted)' }}>{rValue(row.expectancy_r)} · {row.win_rate ?? '—'}% win</div>
        </div>
      ))}
    </section>
  );
}

function ConfirmationLiftChart({ rows }: { rows: ConfirmationStat[] }) {
  const ranked = useMemo(
    () => [...rows]
      .filter((row) => number(row.outcomes) >= 3)
      .sort((a, b) => number(b.expectancy_lift_r) - number(a.expectancy_lift_r))
      .slice(0, 14),
    [rows],
  );
  const maximum = Math.max(0.1, ...ranked.map((row) => Math.abs(number(row.expectancy_lift_r))));
  return (
    <section style={card}>
      <Title title="Confirmation value" description="Expectancy lift versus the pair's baseline at the same horizon." />
      {ranked.length === 0 ? <Empty /> : ranked.map((row) => {
        const lift = number(row.expectancy_lift_r);
        return (
          <div key={`${row.engine}-${row.pair}-${row.confirmation}`} style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, marginBottom: 4 }}>
              <span style={{ fontWeight: 800 }}>{label(row.confirmation)}</span>
              <span style={{ color: 'var(--muted)' }}>{displayPair(row.pair)} · n{row.outcomes}</span>
            </div>
            <div style={track}>
              <div style={{
                height: '100%',
                width: `${Math.max(2, Math.abs(lift) / maximum * 100)}%`,
                marginLeft: lift < 0 ? 'auto' : 0,
                background: lift >= 0 ? 'var(--good)' : 'var(--bad)',
                borderRadius: 4,
                opacity: 0.75,
              }} />
            </div>
            <div style={{ marginTop: 3, fontSize: 10, color: lift >= 0 ? 'var(--good)' : 'var(--bad)' }}>
              {lift >= 0 ? '+' : ''}{lift.toFixed(2)}R lift · {row.win_rate ?? '—'}% win
            </div>
          </div>
        );
      })}
    </section>
  );
}

function PlaybookGrid({ playbooks }: { playbooks: Playbook[] }) {
  return (
    <section>
      <Title title="Current AI pair playbooks" description="Versioned, account-scoped interpretations of deterministic evidence." />
      {playbooks.length === 0 ? <section style={card}><Empty /></section> : (
        <div style={grid}>
          {playbooks.map((playbook) => {
            const ai = playbook.ai_summary || {};
            const windows = Array.isArray(playbook.preferred_scalp_windows) ? playbook.preferred_scalp_windows : [];
            const valuable = Array.isArray(playbook.valuable_confirmations) ? playbook.valuable_confirmations : [];
            return (
              <article key={playbook.id} style={card}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>{displayPair(playbook.pair)} · {playbook.engine.toUpperCase()}</h3>
                  <span style={statusBadge}>{label(playbook.recommendation_stage)} · v{playbook.version}</span>
                </div>
                <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', margin: '12px 0', fontSize: 11, color: 'var(--muted)' }}>
                  <span>n{playbook.sample_size}</span>
                  <span>{playbook.win_rate ?? '—'}% win</span>
                  <span>{rValue(playbook.expectancy_r)}</span>
                  <span>PF {playbook.profit_factor == null ? '—' : Number(playbook.profit_factor).toFixed(2)}</span>
                </div>
                <p style={{ ...muted, color: 'var(--text)' }}>{String(ai.trendThesis || 'No AI thesis generated yet.')}</p>
                <p style={muted}><strong style={{ color: 'var(--accent)' }}>Entry context:</strong> {String(ai.bestEntryContext || 'Insufficient evidence.')}</p>
                <MiniList title="Proven windows" values={windows.map((item) => `${String(item.timeBucketEt || '—')} ET · ${label(item.session)} · ${rValue(item.expectancyR)}`)} />
                <MiniList title="Valuable confirmations" values={valuable.map((item) => `${label(item.confirmation)} · ${rValue(item.liftR)} lift`)} />
                <p style={{ ...muted, color: 'var(--warn)', marginBottom: 0 }}>{String(ai.evidenceWarning || 'Shadow-only.')}</p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MiniList({ title, values }: { title: string; values: string[] }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--muted)', fontWeight: 800, letterSpacing: 0.5 }}>{title}</div>
      {values.length === 0 ? <div style={{ ...muted, marginTop: 4 }}>Not enough evidence.</div> : (
        <ul style={{ margin: '5px 0 0', paddingLeft: 18, fontSize: 11, color: 'var(--text)' }}>
          {values.slice(0, 4).map((value) => <li key={value} style={{ marginBottom: 3 }}>{value}</li>)}
        </ul>
      )}
    </div>
  );
}

function Title({ title, description }: { title: string; description: string }) {
  return (
    <div style={{ marginBottom: 13 }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 800 }}>{title}</h3>
      <p style={{ ...muted, marginTop: 4 }}>{description}</p>
    </div>
  );
}

function Empty() {
  return <p style={muted}>Not enough forward-graded observations yet.</p>;
}

const heading: React.CSSProperties = { margin: 0, fontSize: 17, fontWeight: 800 };
const muted: React.CSSProperties = { margin: 0, color: 'var(--muted)', fontSize: 11, lineHeight: 1.5 };
const card: React.CSSProperties = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 17,
};
const grid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))',
  gap: 16,
};
const track: React.CSSProperties = {
  height: 8,
  background: 'rgba(128,128,160,0.18)',
  borderRadius: 4,
  overflow: 'hidden',
};
const button: React.CSSProperties = {
  background: 'var(--border)',
  color: 'var(--text)',
  border: '1px solid transparent',
  borderRadius: 6,
  padding: '7px 13px',
  fontSize: 11,
  fontWeight: 800,
  cursor: 'pointer',
};
const engineBadge: React.CSSProperties = {
  color: 'var(--muted)',
  fontSize: 9,
  border: '1px solid var(--border)',
  borderRadius: 4,
  padding: '1px 4px',
};
const statusBadge: React.CSSProperties = {
  color: 'var(--accent)',
  fontSize: 9,
  fontWeight: 800,
  border: '1px solid #1a4060',
  borderRadius: 999,
  padding: '3px 7px',
};
