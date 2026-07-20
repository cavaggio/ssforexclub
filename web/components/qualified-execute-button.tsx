'use client';

import { useCallback, useState } from 'react';

type Engine = 'ict' | 'ppr' | 'v3';

type Outcome =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'success'; tradeId?: string; fillPrice?: number; units?: number }
  | { state: 'blocked' | 'error'; reason: string };

function finiteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function QualifiedExecuteButton({
  engine,
  signal,
}: {
  engine: Engine;
  signal: Record<string, any>;
}) {
  const [outcome, setOutcome] = useState<Outcome>({ state: 'idle' });

  const execute = useCallback(async () => {
    setOutcome({ state: 'pending' });
    try {
      const response = await fetch('/api/scanner/execute-qualified', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine, signal }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok || !json?.ok) {
        setOutcome({ state: 'error', reason: json?.error || `HTTP ${response.status}` });
        return;
      }

      const trade = (json.trade ?? {}) as Record<string, any>;
      const pprFill = Array.isArray(trade.executed) && trade.executed.length > 0
        ? trade.executed[0]
        : null;
      const success = trade.success === true || Boolean(pprFill);

      if (success) {
        setOutcome({
          state: 'success',
          tradeId: typeof (pprFill?.tradeId ?? trade.tradeId) === 'string'
            ? String(pprFill?.tradeId ?? trade.tradeId)
            : undefined,
          fillPrice: finiteNumber(pprFill?.fillPrice ?? trade.fillPrice),
          units: finiteNumber(pprFill?.units ?? trade.units),
        });
        return;
      }

      const skippedReason = Array.isArray(trade.skipped) && trade.skipped.length > 0
        ? trade.skipped[0]?.reason
        : null;
      if (trade.blocked === true || trade.executionState === 'BLOCKED' || skippedReason) {
        setOutcome({
          state: 'blocked',
          reason: skippedReason || trade.reason || 'Blocked by an execution safety guard.',
        });
        return;
      }

      setOutcome({
        state: 'error',
        reason: trade.reason || trade.error || 'Broker execution did not succeed.',
      });
    } catch (error) {
      setOutcome({ state: 'error', reason: error instanceof Error ? error.message : String(error) });
    }
  }, [engine, signal]);

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
      <button
        type="button"
        onClick={execute}
        disabled={outcome.state === 'pending' || outcome.state === 'success'}
        style={{
          padding: '10px 18px',
          borderRadius: 8,
          border: outcome.state === 'success' ? '1px solid #2dff7a' : '1px solid #4db8ff',
          background: outcome.state === 'success' ? '#0d3320' : '#0d1f32',
          color: outcome.state === 'success' ? '#2dff7a' : '#7cc8ff',
          fontFamily: 'inherit',
          fontWeight: 850,
          fontSize: 12,
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
          cursor: outcome.state === 'pending' || outcome.state === 'success' ? 'not-allowed' : 'pointer',
        }}
      >
        {outcome.state === 'pending'
          ? 'Executing…'
          : outcome.state === 'success'
            ? '✓ Trade executed'
            : `Execute ${engine.toUpperCase()} trade`}
      </button>

      {outcome.state === 'success' && (
        <div style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid #1a5c38', background: '#0d2218', color: '#8fffb5', fontSize: 12 }}>
          Filled{outcome.tradeId ? ` · trade ${outcome.tradeId}` : ''}{outcome.fillPrice != null ? ` · fill ${outcome.fillPrice}` : ''}{outcome.units != null ? ` · ${outcome.units} units` : ''}
        </div>
      )}

      {(outcome.state === 'blocked' || outcome.state === 'error') && (
        <div style={{ padding: '8px 10px', borderRadius: 7, border: '1px solid #5c1a1a', background: '#320d0d', color: '#ff9999', fontSize: 12, lineHeight: 1.45 }}>
          <strong>{outcome.state === 'blocked' ? 'Blocked:' : 'Execution error:'}</strong> {outcome.reason}
        </div>
      )}
    </div>
  );
}
