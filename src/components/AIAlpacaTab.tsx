import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  alpacaProfileService,
  type AlpacaProfile,
  type AlpacaCredentialsInput,
  type AlpacaEnvironment,
} from '../services/alpacaProfileService';
import {
  alpacaLiveTrading,
  RISK_CONFIG,
  isWithinTradingWindow,
  getEasternTimeString,
  type LiveAccount,
  type LivePosition,
  type LiveOrder,
  type RiskState,
  type TradeSignal,
  type TradeLogEntry,
  type TradingRuleCheck,
} from '../services/alpacaLiveTrading';
import {
  claudeAdvisor,
  type ClaudeTradeEvaluation,
  type ClaudeEvaluationResult,
  type MarketContext,
} from '../services/claudeAdvisor';
import { tradeRiskEngine, type RiskDecision, type ExecutionGate } from '../services/tradeRiskEngine';
import { alpacaExecutionEngine, type ExecutionRecord } from '../services/alpacaExecutionEngine';
import { accountState, type AccountState, OPTIONS_CONTRACT_MULTIPLIER, MIN_BUYING_POWER_RESERVE } from '../services/accountState';
import { supabase } from '../lib/supabase';
import { alpacaUniverse, type UniverseSource, type BatchState } from '../lib/alpacaUniverse';
import generateAlpacaAISignals, { getAlpacaAIScanStatus } from '../lib/signalEngine';

console.log("🔥 AIAlpacaTab ACTIVE");

// ── Inline SVG icons ──────────────────────────────────────────────────────────

const Ic = {
  Shield: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Key:    () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>,
  Check:  () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  X:      () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Alert:  () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Spin:   ({ on }: { on: boolean }) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={on ? { animation: 'spin .7s linear infinite' } : {}}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>,
  Eye:    () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  EyeOff: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  Link:   () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  Unlink: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  Stop:   () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>,
  Bolt:   () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  Clock:  () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Brain:  () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2Z"/></svg>,
  Play:   () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  Wallet: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>,
  List:   () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  ArrowDown: () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>,
  ArrowUp:   () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>,
};

// ── Shared style atoms ────────────────────────────────────────────────────────

const S = {
  panel: (accent: string): React.CSSProperties => ({
    background: '#0f172a', border: `1px solid ${accent}33`, borderRadius: 8,
    overflow: 'hidden', position: 'relative',
  }),
  top: (accent: string): React.CSSProperties => ({
    position: 'absolute', top: 0, left: 0, right: 0, height: 2, background: accent,
  }),
  ph: { padding: '9px 13px', borderBottom: '1px solid #1e293b', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } as React.CSSProperties,
  pt: { fontSize: 10, fontWeight: 700, letterSpacing: '.14em', color: '#cbd5e1', textTransform: 'uppercase' as const, display: 'flex', alignItems: 'center', gap: 5 },
  pb: { padding: '12px 13px' } as React.CSSProperties,
  label: { display: 'block', fontSize: 9, fontWeight: 700, color: '#475569', letterSpacing: '.08em', textTransform: 'uppercase' as const, marginBottom: 4 } as React.CSSProperties,
  input: { width: '100%', boxSizing: 'border-box' as const, background: '#1e293b', border: '1px solid #334155', borderRadius: 5, color: '#e2e8f0', fontSize: 11, padding: '7px 9px', outline: 'none', fontFamily: 'JetBrains Mono, monospace' } as React.CSSProperties,
  badge: (color: string, bg: string, border: string): React.CSSProperties => ({
    fontSize: 8, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase',
    padding: '2px 6px', borderRadius: 3, background: bg, border: `1px solid ${border}`, color,
  }),
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #1e293b' } as React.CSSProperties,
  rowLabel: { fontSize: 9, color: '#475569', fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' as const },
  rowValue: { fontSize: 10, color: '#e2e8f0' },
};

// ── Small reusable components ─────────────────────────────────────────────────

function Badge({ label, color, bg, border }: { label: string; color: string; bg: string; border: string }) {
  return <span style={S.badge(color, bg, border)}>{label}</span>;
}

function StatusBadge({ v }: { v: string }) {
  const map: Record<string, [string, string, string]> = {
    connected:    ['#10b981', 'rgba(16,185,129,.12)',  'rgba(16,185,129,.3)'],
    idle:         ['#64748b', 'rgba(100,116,139,.12)', 'rgba(100,116,139,.3)'],
    validating:   ['#f59e0b', 'rgba(245,158,11,.12)',  'rgba(245,158,11,.3)'],
    failed:       ['#ef4444', 'rgba(239,68,68,.12)',   'rgba(239,68,68,.3)'],
    disconnecting:['#f59e0b', 'rgba(245,158,11,.12)',  'rgba(245,158,11,.3)'],
    paper:        ['#0ea5e9', 'rgba(14,165,233,.12)',  'rgba(14,165,233,.3)'],
    live:         ['#ef4444', 'rgba(239,68,68,.12)',   'rgba(239,68,68,.3)'],
    shadow:       ['#f59e0b', 'rgba(245,158,11,.12)',  'rgba(245,158,11,.3)'],
    submitted:    ['#38bdf8', 'rgba(56,189,248,.12)',  'rgba(56,189,248,.3)'],
    filled:       ['#10b981', 'rgba(16,185,129,.12)',  'rgba(16,185,129,.3)'],
    blocked:      ['#64748b', 'rgba(100,116,139,.12)', 'rgba(100,116,139,.3)'],
    canceled:     ['#94a3b8', 'rgba(148,163,184,.12)', 'rgba(148,163,184,.3)'],
    rejected:     ['#ef4444', 'rgba(239,68,68,.12)',   'rgba(239,68,68,.3)'],
  };
  const [c, bg, border] = map[v] ?? ['#64748b', 'rgba(100,116,139,.12)', 'rgba(100,116,139,.3)'];
  return <Badge label={v} color={c} bg={bg} border={border} />;
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      style={{ position: 'relative', display: 'inline-flex', width: 34, height: 18, borderRadius: 9, border: 'none', cursor: disabled ? 'not-allowed' : 'pointer', background: on ? '#10b981' : '#334155', opacity: disabled ? 0.4 : 1, transition: 'background .2s', flexShrink: 0, padding: 0 }}>
      <span style={{ position: 'absolute', top: 1, left: on ? 17 : 1, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .18s' }} />
    </button>
  );
}

function PnlBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 99, overflow: 'hidden', height: 4, flex: 1 }}>
      <div style={{ height: 4, width: `${Math.min(100, Math.abs(pct))}%`, background: color, borderRadius: 99, transition: 'width .4s' }} />
    </div>
  );
}

// ── Connection status type ────────────────────────────────────────────────────

type ConnStatus = 'idle' | 'validating' | 'connected' | 'failed' | 'disconnecting';

// ── Main Tab ──────────────────────────────────────────────────────────────────

export function AIAlpacaTab({ signals: incomingSignals = [] }: { signals?: any[] }) {

  // ── Profile / connection state ────────────────────────────────────────
  const [profile, setProfile]       = useState<AlpacaProfile | null>(null);
  const [connStatus, setConnStatus] = useState<ConnStatus>('idle');
  const [connError, setConnError]   = useState('');
  const [apiKey, setApiKey]         = useState('');
  const [apiSecret, setApiSecret]   = useState('');
  const [environment, setEnvironment] = useState<AlpacaEnvironment>('live');
  const [showSecret, setShowSecret] = useState(false);

  // ── Trading controls ──────────────────────────────────────────────────
  const [liveTradingEnabled, setLiveTradingEnabled] = useState(false);
  const [autoTradeEnabled, setAutoTradeEnabled]     = useState(false);
  const [shadowMode, setShadowMode] = useState(false); // default ON
  const [killConfirm, setKillConfirm]               = useState(false);
  const [liveConfirmed, setLiveConfirmed]            = useState(false);

  // ── Live account data ─────────────────────────────────────────────────
  const [liveAccount, setLiveAccount]   = useState<LiveAccount | null>(null);
  const [positions, setPositions]       = useState<LivePosition[]>([]);
  const [openOrders, setOpenOrders]     = useState<LiveOrder[]>([]);
  const [riskState, setRiskState]       = useState<RiskState>({
    tradesToday: 0, consecutiveLosses: 0, dailyPnl: 0,
    tradingDisabled: false, dailyTargetReached: false,
  });
  const [accountError, setAccountError] = useState('');
  const [loadingAccount, setLoadingAccount] = useState(false);

  // ── Signal evaluation ─────────────────────────────────────────────────
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [signalSource, setSignalSource] = useState<UniverseSource | 'loading'>('loading');
  const [signalWarning, setSignalWarning] = useState('');
  const [loadingSignals, setLoadingSignals] = useState(false);
  const [scanBatchState, setScanBatchState] = useState<BatchState | null>(null);
  const [lastScanMessage, setLastScanMessage] = useState('Alpaca AI has not scanned yet');
  const [ruleChecks, setRuleChecks]     = useState<TradingRuleCheck[]>([]);
  const [allRulesPass, setAllRulesPass] = useState(false);

  // ── Trade log ─────────────────────────────────────────────────────────
  const [tradeLog, setTradeLog]         = useState<TradeLogEntry[]>([]);
  const [submitting, setSubmitting]     = useState(false);

  // ── Claude Advisor state ──────────────────────────────────────────────
  const [claudeResult, setClaudeResult]     = useState<ClaudeEvaluationResult | null>(null);
  const [claudeRunning, setClaudeRunning]   = useState(false);
  const [claudeError, setClaudeError]       = useState('');
  const [dryRunResult, setDryRunResult]     = useState<{ riskDecision: RiskDecision; executionGate: ExecutionGate; summary: string } | null>(null);
  const [liveAutoTradeConfirmed, setLiveAutoTradeConfirmed]           = useState(false); // must be explicitly set true by user action

  // ── Execution lifecycle state ─────────────────────────────────────────
  const [execRecords, setExecRecords]     = useState<ExecutionRecord[]>([]);
  const [activeExecId, setActiveExecId]   = useState<string | null>(null);  // order in flight
  const [acctState, setAcctState]         = useState<AccountState | null>(null);
  const [acctStateError, setAcctStateError] = useState('');
  const [preTradeBP, setPreTradeBP]       = useState<number | null>(null);
  const [postTradeBP, setPostTradeBP]     = useState<number | null>(null);
  const [fetchingAcct, setFetchingAcct]   = useState(false);

  // ── Scheduler refs ────────────────────────────────────────────────────
  const loopRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionId = useRef(crypto.randomUUID());

  const isConnected = connStatus === 'connected' && profile !== null;
  const isLive      = profile?.environment === 'live' || environment === 'live';

  //
  async function manualExecute(signal: TradeSignal) {
  try {
    console.log("🚀 EXECUTE START", signal);

    if (!signal?.optionSymbol) {
      alert("No option contract selected");
      return;
    }

    const response = await fetch(
      "http://localhost:3001/api/alpaca/live/trade",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          signal,
          qty: 1,
          shadowMode: false,
        }),
      }
    );

    const raw = await response.text();

    console.log("RAW TRADE RESPONSE:", raw);

    let result: any;

    try {
      result = JSON.parse(raw);
    } catch {
      console.error("NON-JSON TRADE RESPONSE DETAILS:", {
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        contentType: response.headers.get("content-type"),
        rawStart: raw.slice(0, 500),
      });
      alert("Backend returned HTML instead of JSON. Check console.");

      return;
    }

    console.log("🚀 LIVE TRADE RESULT", result);

    if (!response.ok) {
      alert(result?.error || "Trade failed");
      return;
    }

    if (result?.action === "submit") {
      alert(`LIVE ORDER SUBMITTED: ${signal.optionSymbol}`);

      setExecRecords(prev => [
        {
          ticker: signal.ticker,
          optionSymbol: signal.optionSymbol,
          orderStatus: "submitted",
          fillStatus: "pending",
          quantity: 1,
          limitPrice: signal.limitPrice,
          createdAt: new Date().toISOString(),
        } as any,
        ...prev
      ]);
    } else {
      alert(`Trade blocked: ${result?.reason || "Unknown reason"}`);
    }

  } catch (err) {
    console.error("🚨 EXECUTION ERROR", err);

    alert(
      err instanceof Error
        ? err.message
        : "Execution failed"
    );
  }
}

  // ── Load saved profile on mount ───────────────────────────────────────
  useEffect(() => {
    const saved = alpacaProfileService.getProfile();
    if (saved) {
      setProfile(saved);
      setConnStatus('connected');
      setLiveTradingEnabled(saved.tradingEnabled);
      setAutoTradeEnabled(saved.autoTradeEnabled);
    }
  }, []);

  // ── Fetch live account data when connected ────────────────────────────
  const fetchLiveData = useCallback(async () => {
    if (!isConnected) return;
    setLoadingAccount(true);
    setAccountError('');
    try {
      const [acct, pos, ord, risk] = await Promise.all([
        alpacaLiveTrading.getAccount().catch(e => { throw e; }),
        alpacaLiveTrading.getPositions().catch(() => [] as LivePosition[]),
        alpacaLiveTrading.getOpenOrders().catch(() => [] as LiveOrder[]),
        alpacaLiveTrading.getRiskState().catch(() => riskState),
      ]);
      setLiveAccount(acct);
      setPositions(pos);
      setOpenOrders(ord);
      setRiskState({ ...risk, dailyTargetReached: acct.equity > 0 && risk.dailyPnl >= acct.equity * RISK_CONFIG.DAILY_TARGET_PCT });
    } catch (e) {
      setAccountError(e instanceof Error ? e.message : 'Failed to fetch account');
    } finally {
      setLoadingAccount(false);
    }
  }, [isConnected]);

  // ── Refresh every 30s when connected ─────────────────────────────────
  useEffect(() => {
    if (!isConnected) return;
    fetchLiveData();
    const t = setInterval(fetchLiveData, 30_000);
    return () => clearInterval(t);
  }, [isConnected, fetchLiveData]);

  // ── Fetch accountState (buying power aware) ───────────────────────────
  const fetchAccountState = useCallback(async (force = false) => {
    if (!isConnected) return;
    setFetchingAcct(true);
    setAcctStateError('');
    try {
      const env = profile?.environment ?? 'live';
      const state = await accountState.getAccountState(env, force);
      setAcctState(state);
    } catch (e) {
      setAcctStateError(e instanceof Error ? e.message : 'Failed to fetch account state');
    } finally {
      setFetchingAcct(false);
    }
  }, [isConnected, profile]);

  useEffect(() => {
    if (!isConnected) return;
    fetchAccountState(true);
    const t = setInterval(() => fetchAccountState(false), 20_000);
    return () => clearInterval(t);
  }, [isConnected, fetchAccountState]);

  // ── Load live Alpaca symbols for signal evaluation panel ──────────────
  useEffect(() => {
    let cancelled = false;

    const loadSignalCandidates = async () => {
      setLoadingSignals(true);
      try {
        const { batch, state } = await alpacaUniverse.nextBatch();
        if (cancelled) return;

        console.log("🔥 BATCH SIZE:", batch.length);

        const liveSignals = await generateAlpacaAISignals(batch);
        console.log("AI-ALPACA RECEIVED SIGNALS:", liveSignals.length);
        console.log("QUALIFIED COUNT:", liveSignals.length);


        console.log("LIVE SIGNALS:", liveSignals);

        const scanStatus = getAlpacaAIScanStatus();

        const nextBatchState: BatchState = {
          ...state,
          qualifiedSignals: liveSignals.length,
        };

        // CHANGE 6 — daily target tracking (informational only, never blocks)
        if (liveAccount) {
          const dailyTarget = liveAccount.equity * 0.02;
          console.log("DAILY TARGET:", dailyTarget);
        }

        console.log("🔥 LIVE SIGNALS RECEIVED IN UI:", liveSignals.length);
        console.log("LIVE SIGNAL DATA:", liveSignals);
        setSignals(liveSignals);
        setScanBatchState(nextBatchState);
        setLastScanMessage(scanStatus.message);
        setSignalSource(state.dataSource);
        setSignalWarning(state.warning ?? scanStatus.message ?? '');
      } catch (err) {
        if (cancelled) return;
        setSignals([]);
        setScanBatchState(null);
        setLastScanMessage(err instanceof Error ? err.message : 'Unable to load Alpaca symbols');
        setSignalSource('loading');
        setSignalWarning(err instanceof Error ? err.message : 'Unable to load Alpaca symbols');
      } finally {
        if (!cancelled) setLoadingSignals(false);
      }
    };

    loadSignalCandidates();
    const t = setInterval(loadSignalCandidates, 60000);

    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [liveAccount]);

  // ── Evaluate rules when inputs change ─────────────────────────────────
  useEffect(() => {
    if (!signals.length) {
      setRuleChecks([]);
      setAllRulesPass(false);
      return;
    }
    const best = signals[0];
    const dummyAccount: LiveAccount = liveAccount ?? {
      accountNumber: '', buyingPower: 0, cash: 0, portfolioValue: 0, equity: 5000,
      daytradeCount: 0, status: 'ACTIVE', tradingBlocked: false, accountBlocked: false, patternDayTrader: false,
    };
    const { checks, pass } = alpacaLiveTrading.evaluateRules(best, dummyAccount, riskState, positions, openOrders);
    setRuleChecks(checks);
    setAllRulesPass(pass);
  }, [signals, liveAccount, riskState, positions, openOrders]);

  // ── 5-minute trading loop ─────────────────────────────────────────────
  useEffect(() => {
    if (loopRef.current) clearInterval(loopRef.current);
    if (!isConnected || !autoTradeEnabled || !liveTradingEnabled) return;

    const runLoop = async () => {
      if (!isWithinTradingWindow()) return;

      // Failsafe: never run if another order is still in flight
      if (activeExecId) return;

      await fetchLiveData();
      const acct = liveAccount;
      if (!acct) return;

      // Refresh buying power before evaluating any signal
      await fetchAccountState(true);
      const currentAcct = accountState.getCached();
      if (!currentAcct) return;

      for (const signal of signals) {
        const qty = Math.max(1, alpacaLiveTrading.calculatePositionSize(signal, acct.equity));

        // ── Buying power pre-check ──────────────────────────────────
        const bpCheck = accountState.checkBuyingPower(signal.limitPrice, qty, currentAcct.buyingPower);
        if (!bpCheck.sufficient) {
          const entry = alpacaLiveTrading.buildLogEntry(signal, qty, 'blocked', bpCheck.blockedReason ?? 'INSUFFICIENT BUYING POWER', undefined, profile!.environment, shadowMode);
          addToLog(entry);
          await persistLogEntry(entry);
          continue;
        }

        // ── Claude advisory ─────────────────────────────────────────
        let claudeEval: ClaudeTradeEvaluation | null = null;
        try {
          const marketCtx: MarketContext = { spyTrend: 'BULLISH', vixLevel: '15', putCallRatio: '0.8', sentiment: 'BULLISH' };
          const claudeRes = await claudeAdvisor.evaluateTradeWithClaude(signal, marketCtx);
          claudeEval = claudeRes.evaluation;
          setClaudeResult(claudeRes);
        } catch (err) {
          const entry = alpacaLiveTrading.buildLogEntry(
            signal,
            qty,
            'blocked',
            `AI ranking unavailable: ${err instanceof Error ? err.message : 'Claude unavailable'}`,
            undefined,
            profile!.environment,
            shadowMode,
          );
          addToLog(entry);
          await persistLogEntry(entry);
          continue;
        }

        if (claudeEval.advisoryDecision !== 'APPROVE') {
          const entry = alpacaLiveTrading.buildLogEntry(
            signal,
            qty,
            'blocked',
            `AI decision ${claudeEval.advisoryDecision}`,
            undefined,
            profile!.environment,
            shadowMode,
          );
          addToLog(entry);
          await persistLogEntry(entry);
          continue;
        }

        const approvedSignal = { ...signal, aiDecision: claudeEval.advisoryDecision };

        // ── Risk Engine gate ────────────────────────────────────────
        const riskDecision = tradeRiskEngine.evaluate(approvedSignal, acct, riskState, positions, openOrders, claudeEval);
        const executionGate = tradeRiskEngine.computeExecutionGate(riskDecision, liveTradingEnabled, autoTradeEnabled, shadowMode, liveAutoTradeConfirmed);

        if (!executionGate.canExecute) {
          const reason = executionGate.blockedReasons[0] ?? 'Risk engine blocked';
          const entry = alpacaLiveTrading.buildLogEntry(approvedSignal, qty, 'blocked', reason, undefined, profile!.environment, shadowMode);
          addToLog(entry);
          await persistLogEntry(entry);
          continue;
        }

        // ── Full execution lifecycle ────────────────────────────────
        setSubmitting(true);
        setPreTradeBP(currentAcct.buyingPower);

        const tempId = crypto.randomUUID();
        setActiveExecId(tempId);

        try {
          const result = await alpacaExecutionEngine.executeTrade(
            approvedSignal, qty, shadowMode, profile!.environment, sessionId.current,
            (record) => {
              // Live status updates as order progresses
              setExecRecords(prev => {
                const idx = prev.findIndex(r => r.id === record.id);
                if (idx >= 0) { const next = [...prev]; next[idx] = record; return next; }
                return [record, ...prev].slice(0, 50);
              });
              // Also update the legacy trade log
              const legacyEntry = alpacaLiveTrading.buildLogEntry(
                approvedSignal, record.quantity,
                (record.orderStatus as any) ?? 'blocked',
                record.blockedReason ?? undefined,
                record.orderId ?? undefined,
                profile!.environment, shadowMode,
              );
              addToLog(legacyEntry);
            },
          );

          setPostTradeBP(result.postTradeBuyingPower);
          accountState.invalidate();
          await fetchAccountState(true);

          // Persist to legacy trade_log too
          const finalEntry = alpacaLiveTrading.buildLogEntry(
            approvedSignal, qty,
            result.executionRecord.orderStatus === 'filled' ? 'filled'
            : result.executionRecord.orderStatus === 'submitted' ? 'submitted'
            : result.executionRecord.orderStatus === 'shadow' ? 'shadow' : 'blocked',
            result.blockedReason ?? undefined,
            result.executionRecord.orderId ?? undefined,
            profile!.environment, shadowMode,
          );
          await persistLogEntry(finalEntry);

        } catch (e) {
          const entry = alpacaLiveTrading.buildLogEntry(signal, qty, 'rejected', e instanceof Error ? e.message : 'Unknown', undefined, profile!.environment, shadowMode);
          addToLog(entry);
        } finally {
          setSubmitting(false);
          setActiveExecId(null);
        }
        break; // only one signal per loop cycle
      }
    };

    loopRef.current = setInterval(runLoop, RISK_CONFIG.LOOP_INTERVAL_MS);
    return () => { if (loopRef.current) clearInterval(loopRef.current); };
  }, [isConnected, autoTradeEnabled, liveTradingEnabled, liveAccount, riskState, positions, openOrders, signals, shadowMode, profile, activeExecId]);

  function addToLog(entry: TradeLogEntry) {
    setTradeLog(prev => [entry, ...prev].slice(0, 100));
  }

  async function persistLogEntry(entry: TradeLogEntry) {
    await supabase.from('trade_log').insert({
      session_id:       sessionId.current,
      timestamp:        entry.timestamp,
      ticker:           entry.ticker,
      option_symbol:    entry.optionSymbol,
      signal_score:     entry.signalScore,
      confidence:       entry.confidence,
      risk_reward:      entry.riskReward,
      grade:            entry.grade,
      entry_price:      entry.entryPrice ?? null,
      qty:              entry.qty,
      side:             (entry as any).side ?? 'buy',
      status:           entry.status,
      rejection_reason: entry.rejectionReason ?? null,
      order_id:         entry.orderId ?? null,
      environment:      entry.environment,
      shadow_mode:      entry.shadowMode,
    });
  }

  // ── Connect form handlers ─────────────────────────────────────────────
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey.trim() || !apiSecret.trim()) return;
    setConnStatus('validating');
    setConnError('');
    try {
      const result = await alpacaProfileService.validateCredentials({ apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), environment } as AlpacaCredentialsInput);
      if (!result.success) throw new Error(result.error ?? 'Validation failed');
      const saved = alpacaProfileService.saveProfile({ environment, accountType: 'individual', tradingEnabled: false, autoTradeEnabled: false, accountStatus: result.accountStatus, accountNumberMasked: result.accountNumberMasked });
      setProfile(saved);
      setConnStatus('connected');
      setLiveTradingEnabled(false);
      setAutoTradeEnabled(false);
      setApiKey('');
      setApiSecret('');
    } catch (err) {
      setConnStatus('failed');
      setConnError(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const handleDisconnect = () => {
    setConnStatus('disconnecting');
    if (loopRef.current) clearInterval(loopRef.current);
    setTimeout(() => {
      alpacaProfileService.disconnectProfile();
      setProfile(null); setConnStatus('idle'); setLiveTradingEnabled(false);
      setAutoTradeEnabled(false); setLiveAccount(null); setPositions([]); setOpenOrders([]); setConnError('');
    }, 500);
  };

  const handleKillSwitch = async () => {
    setKillConfirm(false);
    setAutoTradeEnabled(false);
    setLiveTradingEnabled(false);
    if (loopRef.current) clearInterval(loopRef.current);
    await alpacaLiveTrading.disableTrading('Emergency kill switch activated');
    const entry = alpacaLiveTrading.buildLogEntry(signals[0] ?? { ticker: 'SYSTEM' } as any, 0, 'blocked', 'Kill switch activated', undefined, profile?.environment ?? 'live', shadowMode);
    addToLog({ ...entry, ticker: 'SYSTEM', optionSymbol: '—' });
    setRiskState(s => ({ ...s, tradingDisabled: true, disableReason: 'Emergency kill switch' }));
    if (profile) alpacaProfileService.saveProfile({ ...profile, tradingEnabled: false, autoTradeEnabled: false });
  };

  const handleLiveTradingToggle = (v: boolean) => {
    if (!isConnected) return;
    if (v) setLiveConfirmed(true);
    setLiveTradingEnabled(v);
    if (!v) {
      setAutoTradeEnabled(false);
    }
    if (profile) {
      alpacaProfileService.saveProfile({
        ...profile,
        environment: 'live',
        tradingEnabled: v,
        autoTradeEnabled: v ? autoTradeEnabled : false,
      });
    }
  };

  // ── Claude dry-run advisory test ─────────────────────────────────────
  const handleClaudeDryRun = async () => {
    console.log("CLAUDE DRY RUN BUTTON CLICKED");

    if (claudeRunning) return;
    setClaudeRunning(true);
    setClaudeError('');
    setDryRunResult(null);

    try {
      // Step 0 — Resolve the target signal.
      // Use cached signals if available; otherwise run a fresh scan through
      // the current qualification pipeline so the dry run always exercises
      // the same path as the auto-scan.
      let targetSignal = signals[0] ?? null;

      if (!targetSignal) {
        console.log("DRY RUN: no cached signal — triggering fresh scan");
        const { batch } = await alpacaUniverse.nextBatch();
        console.log("DRY RUN BATCH SIZE:", batch.length);

        if (!batch.length) {
          setClaudeError('No symbols available — check Alpaca connection.');
          return;
        }

        const freshSignals = await generateAlpacaAISignals(batch);
        console.log("DRY RUN FRESH SIGNALS:", freshSignals.length);

        if (!freshSignals.length) {
          setClaudeError('Scan returned 0 qualifying signals. Open the browser console and look for SIGNAL CHECK / CONFIDENCE RANGE diagnostics.');
          return;
        }

        setSignals(freshSignals);
        targetSignal = freshSignals[0];
      }

      console.log("DRY RUN SIGNAL:", {
        ticker:            targetSignal.ticker,
        optionSymbol:      (targetSignal as any).optionSymbol,
        confidence:        (targetSignal as any).confidence,
        repeatabilityScore:(targetSignal as any).repeatabilityScore,
        grade:             (targetSignal as any).grade,
        status:            (targetSignal as any).status,
      });

      const marketCtx: MarketContext = {
        spyTrend:     'BULLISH',
        vixLevel:     '15.2',
        putCallRatio: '0.76',
        sentiment:    'BULLISH',
      };

      // Step 1 — Ask Claude
      console.log("DRY RUN: calling Claude advisor...");
      const claudeRes = await claudeAdvisor.evaluateTradeWithClaude(targetSignal, marketCtx);
      console.log("DRY RUN CLAUDE RESULT:", claudeRes.evaluation.advisoryDecision, claudeRes.evaluation.tradeThesis?.slice(0, 80));
      setClaudeResult(claudeRes);

      // Step 2 — Risk Engine gate
      const dummyAccount: LiveAccount = liveAccount ?? {
        accountNumber: '', buyingPower: 0, cash: 0, portfolioValue: 0, equity: 5000,
        daytradeCount: 0, status: 'ACTIVE', tradingBlocked: false, accountBlocked: false, patternDayTrader: false,
      };
      const riskDecision = tradeRiskEngine.evaluate(
        targetSignal, dummyAccount, riskState, positions, openOrders, claudeRes.evaluation,
      );
      console.log("DRY RUN RISK:", riskDecision.approved ? 'APPROVED' : `BLOCKED — ${riskDecision.blockedReason}`);

      const executionGate = tradeRiskEngine.computeExecutionGate(
        riskDecision, liveTradingEnabled, autoTradeEnabled, shadowMode, liveAutoTradeConfirmed,
      );
      console.log("DRY RUN GATE:", executionGate.canExecute ? 'CAN EXECUTE' : `BLOCKED — ${executionGate.blockedReasons.join(', ')}`);

      const summary = claudeAdvisor.summarizeTradeDecision(targetSignal, claudeRes.evaluation, riskDecision);
      setDryRunResult({ riskDecision, executionGate, summary });
      console.log("DRY RUN COMPLETE:", summary);

      // Log dry-run to trade log (never submits an order)
      const logEntry = alpacaLiveTrading.buildLogEntry(
        targetSignal, 1,
        'blocked',
        `DRY RUN — Claude: ${claudeRes.evaluation.advisoryDecision} | Risk: ${riskDecision.approved ? 'PASS' : riskDecision.blockedReason}`,
        undefined,
        profile?.environment ?? 'live',
        true,
      );
      addToLog({ ...logEntry, status: 'shadow' });

    } catch (err) {
      console.error("DRY RUN ERROR:", err);
      setClaudeError(err instanceof Error ? err.message : 'Claude evaluation failed');
    } finally {
      setClaudeRunning(false);
    }
  };

  const handleAutoTradeToggle = (v: boolean) => {
    if (!liveTradingEnabled) return;
    setAutoTradeEnabled(v);
    if (profile) alpacaProfileService.saveProfile({ ...profile, autoTradeEnabled: v });
  };

  const inWindow = isWithinTradingWindow();
  const dailyPct = liveAccount?.equity ? (riskState.dailyPnl / liveAccount.equity) * 100 : 0;
  const targetPct = RISK_CONFIG.DAILY_TARGET_PCT * 100;
  const lossPct   = RISK_CONFIG.MAX_DAILY_LOSS_PCT * 100;
  const signalSourceLabel = signalSource === 'alpaca' ? 'ALPACA AI' : signalSource === 'fallback' ? 'FALLBACK' : 'LOADING';
  const signalSourceColor = signalSource === 'alpaca' ? '#10b981' : signalSource === 'fallback' ? '#f59e0b' : '#64748b';
  const scanCoverageLabel = scanBatchState
    ? `${scanBatchState.currentBatchStart}-${scanBatchState.currentBatchEnd} / ${scanBatchState.totalSymbols}`
    : '—';
  const scannedTodayLabel = scanBatchState
    ? scanBatchState.scannedSymbolsToday.toLocaleString()
    : '0';

  // ── Render ────────────────────────────────────────────────────────────

  console.log("🔥 SIGNALS BEFORE RENDER:", signals.length);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, animation: 'fadeIn .3s ease forwards' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}} @keyframes fadeIn{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* ── Page header ── */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f1f5f9', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 7 }}>
            <Ic.Shield /> AI-Alpaca Options Engine
            <StatusBadge v={connStatus} />
            {shadowMode && <Badge label="SHADOW MODE" color="#f59e0b" bg="rgba(245,158,11,.12)" border="rgba(245,158,11,.3)" />}
          </div>
          <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>
            Live options auto-trading with Signal Stack risk controls. Real money at risk — review all settings before enabling.
          </div>
        </div>
        {isConnected && (
          <button type="button" onClick={handleDisconnect} style={{ padding: '6px 12px', fontSize: 10, fontWeight: 700, borderRadius: 5, border: '1px solid rgba(239,68,68,.4)', cursor: 'pointer', background: 'rgba(239,68,68,.1)', color: '#f87171', display: 'flex', alignItems: 'center', gap: 5 }}>
            <Ic.Unlink /> Disconnect
          </button>
        )}
      </div>

      {/* ── Live money warning ── */}
      {isLive && (
        <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 7, padding: '9px 13px', display: 'flex', gap: 9, alignItems: 'flex-start' }}>
          <span style={{ color: '#f87171', flexShrink: 0, marginTop: 1 }}><Ic.Alert /></span>
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#fca5a5', marginBottom: 2 }}>Live Account — Real Money at Risk</div>
            <div style={{ fontSize: 9, color: '#f87171', lineHeight: 1.5 }}>
              This account is connected to <strong>Alpaca Live (api.alpaca.markets)</strong>. Options orders execute with real funds.
              Max risk per trade: <strong>1% equity</strong>. Max daily loss: <strong>2% equity</strong>. Auto-trading is OFF by default.
            </div>
          </div>
        </div>
      )}

      {/* ── Daily target / loss banners ── */}
      {riskState.dailyTargetReached && (
        <div style={{ background: 'rgba(16,185,129,.08)', border: '1px solid rgba(16,185,129,.3)', borderRadius: 7, padding: '8px 13px', fontSize: 10, fontWeight: 700, color: '#34d399', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Ic.Bolt /> Daily Target Reached (+{targetPct}%) — New Trades Disabled. Open positions still managed.
        </div>
      )}
      {riskState.tradingDisabled && !riskState.dailyTargetReached && (
        <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 7, padding: '8px 13px', fontSize: 10, fontWeight: 700, color: '#f87171', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Ic.Stop /> Trading Disabled — {riskState.disableReason ?? `Daily loss limit reached (-${lossPct}%)`}
        </div>
      )}

      {/* ── Three-column layout ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 320px', gap: 12 }}>

        {/* ═══ LEFT COLUMN ═══ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Connection form / account status */}
          {!isConnected ? (
            <div style={S.panel('#0ea5e9')}>
              <div style={S.top('#0ea5e9')} />
              <div style={S.ph}>
                <span style={S.pt}><Ic.Key /> Connect Alpaca Account</span>
                <StatusBadge v={connStatus} />
              </div>
              <div style={S.pb}>
                <form onSubmit={handleConnect} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <div>
                    <label style={S.label}>Environment</label>
                    <div style={{ display: 'flex', gap: 5 }}>
                      {(['paper', 'live'] as AlpacaEnvironment[]).map(env => (
                        <button key={env} type="button" onClick={() => setEnvironment(env)}
                          style={{ flex: 1, padding: '7px 0', fontSize: 10, fontWeight: 700, borderRadius: 5, border: `1px solid ${environment === env ? (env === 'live' ? 'rgba(239,68,68,.5)' : 'rgba(14,165,233,.5)') : '#334155'}`, background: environment === env ? (env === 'live' ? 'rgba(239,68,68,.12)' : 'rgba(14,165,233,.12)') : 'transparent', color: environment === env ? (env === 'live' ? '#f87171' : '#38bdf8') : '#475569', cursor: 'pointer', letterSpacing: '.06em', textTransform: 'uppercase' }}>
                          {env}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label style={S.label}>API Key</label>
                    <input type="text" autoComplete="off" spellCheck={false} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="PK…" required style={S.input} />
                  </div>
                  <div>
                    <label style={S.label}>API Secret</label>
                    <div style={{ position: 'relative' }}>
                      <input type={showSecret ? 'text' : 'password'} autoComplete="new-password" spellCheck={false} value={apiSecret} onChange={e => setApiSecret(e.target.value)} placeholder="Never displayed after save" required style={{ ...S.input, paddingRight: 30 }} />
                      <button type="button" onClick={() => setShowSecret(s => !s)} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#475569', padding: 0, display: 'flex' }}>
                        {showSecret ? <Ic.EyeOff /> : <Ic.Eye />}
                      </button>
                    </div>
                  </div>
                  {connStatus === 'failed' && connError && (
                    <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.3)', borderRadius: 5, padding: '7px 10px', fontSize: 10, color: '#f87171', display: 'flex', gap: 6 }}>
                      <Ic.X /> {connError}
                    </div>
                  )}
                  <button type="submit" disabled={connStatus === 'validating' || !apiKey.trim() || !apiSecret.trim()}
                    style={{ padding: '7px 14px', fontSize: 10, fontWeight: 700, borderRadius: 5, border: 'none', cursor: (connStatus === 'validating' || !apiKey || !apiSecret) ? 'not-allowed' : 'pointer', background: 'rgba(14,165,233,.9)', color: '#fff', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 5, opacity: (connStatus === 'validating' || !apiKey || !apiSecret) ? 0.5 : 1 }}>
                    <Ic.Spin on={connStatus === 'validating'} />
                    {connStatus === 'validating' ? 'Validating…' : 'Validate & Connect'}
                  </button>
                </form>
              </div>
            </div>
          ) : (
            /* Live Account Status Card */
            <div style={S.panel('#10b981')}>
              <div style={S.top('#10b981')} />
              <div style={S.ph}>
                <span style={S.pt}><Ic.Bolt /> Live Account Status</span>
                <div style={{ display: 'flex', gap: 5 }}>
                  {loadingAccount && <Ic.Spin on />}
                  <StatusBadge v={liveAccount ? 'connected' : 'idle'} />
                  {profile && <StatusBadge v={profile.environment} />}
                </div>
              </div>
              <div style={S.pb}>
                {accountError ? (
                  <div style={{ fontSize: 10, color: '#f87171', padding: '8px 0', display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', gap: 6 }}><Ic.Alert />{accountError}</div>
                    {accountError.includes('not configured') && (
                      <div style={{ fontSize: 9, color: '#94a3b8', paddingLeft: 18 }}>
                        Alpaca LIVE API credentials are not configured on the backend. Add ALPACA_LIVE_API_KEY and ALPACA_LIVE_API_SECRET to connect.
                      </div>
                    )}
                  </div>
                ) : liveAccount ? (
                  <>
                    <div style={S.row}><span style={S.rowLabel}>Account #</span><span style={{ ...S.rowValue, fontFamily: 'monospace' }}>{liveAccount.accountNumber || profile?.accountNumberMasked || '—'}</span></div>
                    <div style={S.row}><span style={S.rowLabel}>Status</span><StatusBadge v={liveAccount.status?.toLowerCase() === 'active' ? 'connected' : 'failed'} /></div>
                    <div style={S.row}><span style={S.rowLabel}>Equity</span><span style={{ ...S.rowValue, color: '#34d399', fontFamily: 'monospace' }}>${liveAccount.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                    <div style={S.row}><span style={S.rowLabel}>Buying Power</span><span style={{ ...S.rowValue, fontFamily: 'monospace' }}>${liveAccount.buyingPower.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></div>
                    <div style={S.row}><span style={S.rowLabel}>Options Level</span><span style={S.rowValue}>{liveAccount.optionsLevel ?? 'N/A'}</span></div>
                    <div style={S.row}><span style={S.rowLabel}>Trading Blocked</span><span style={{ ...S.rowValue, color: liveAccount.tradingBlocked ? '#f87171' : '#34d399' }}>{liveAccount.tradingBlocked ? 'YES' : 'NO'}</span></div>
                    <div style={S.row}><span style={S.rowLabel}>PDT</span><span style={S.rowValue}>{liveAccount.patternDayTrader ? 'Yes' : 'No'}</span></div>
                    <div style={S.row}><span style={S.rowLabel}>Open Positions</span><span style={S.rowValue}>{positions.length} / {RISK_CONFIG.MAX_OPEN_POSITIONS}</span></div>
                    <div style={S.row}><span style={S.rowLabel}>Open Orders</span><span style={S.rowValue}>{openOrders.length}</span></div>
                  </>
                ) : (
                  <div style={{ fontSize: 10, color: '#475569', padding: '4px 0' }}>
                    Fetching account data…
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Signal Stack Execution Rules */}
          <div style={S.panel('#f59e0b')}>
            <div style={S.top('#f59e0b')} />
            <div style={S.ph}>
              <span style={S.pt}>Signal Stack Execution Rules</span>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                {loadingSignals && <Ic.Spin on />}
                <Badge label={signalSourceLabel} color={signalSourceColor} bg={`${signalSourceColor}1f`} border={`${signalSourceColor}4d`} />
                <Badge label={allRulesPass ? 'ALL PASS' : 'BLOCKED'} color={allRulesPass ? '#34d399' : '#f87171'} bg={allRulesPass ? 'rgba(52,211,153,.12)' : 'rgba(248,113,113,.12)'} border={allRulesPass ? 'rgba(52,211,153,.3)' : 'rgba(248,113,113,.3)'} />
              </div>
            </div>
            <div style={{ padding: '8px 13px', display: 'flex', flexDirection: 'column', gap: 3 }}>
              {signalWarning && (
                <div style={{ fontSize: 9, color: '#f59e0b', padding: '5px 6px', background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.2)', borderRadius: 4 }}>
                  {signalWarning}
                </div>
              )}
              {scanBatchState && (() => {
                const ss = getAlpacaAIScanStatus();
                return (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginBottom: 5 }}>
                      <StatBox label="Batch" value={scanCoverageLabel} color="#38bdf8" />
                      <StatBox label="Scanned Today" value={scannedTodayLabel} color="#a78bfa" />
                      <StatBox label="Executable" value={String(scanBatchState.qualifiedSignals)} color={scanBatchState.qualifiedSignals > 0 ? '#10b981' : '#ef4444'} />
                    </div>
                    {ss.reviewed > 0 && (
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5, marginBottom: 5 }}>
                        <StatBox label="Reviewed" value={String(ss.reviewed)} color="#64748b" />
                        <StatBox label="Qualified" value={String(ss.qualified)} color={ss.qualified > 0 ? '#10b981' : '#f59e0b'} />
                        <StatBox label="Rejected" value={String(ss.rejected)} color={ss.rejected === ss.reviewed ? '#ef4444' : '#64748b'} />
                      </div>
                    )}
                  </>
                );
              })()}

              <div style={{ fontSize: 8, color: '#475569', lineHeight: 1.4, marginBottom: signals.length ? 5 : 0 }}>
                {lastScanMessage}
              </div>

              {signals.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 5, marginBottom: 5 }}>
                  {signals.slice(0, 6).map(sig => {
                    const repeatability = Number((sig as any).repeatabilityScore ?? 0);
                    const score = Number((sig as any).totalScore ?? (sig as any).score ?? 0);
                    const optionSymbol = String((sig as any).optionSymbol || 'No option selected');
                    return (
                      <div key={`${sig.ticker}-${optionSymbol}`} style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: 4, padding: '6px 7px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace' }}>{sig.ticker}</span>
                          <span style={{ fontSize: 8, color: sig.grade === 'A+' ? '#fbbf24' : '#34d399', fontWeight: 700 }}>{sig.grade}</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginTop: 5 }}>
                          <MiniMetric label="Score" value={`${score}/20`} color="#38bdf8" />
                          <MiniMetric label="Conf" value={`${Math.round(sig.confidence)}%`} color="#10b981" />
                          <MiniMetric label="Repeat" value={`${repeatability || '—'}`} color={repeatability >= 80 ? '#10b981' : repeatability >= 72 ? '#f59e0b' : '#64748b'} />
                        </div>
                        <div style={{ fontSize: 7, color: '#64748b', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                          {optionSymbol}
                        </div>

                        <button
                          onClick={() => manualExecute(sig)}
                          style={{
                            marginTop: 6,
                            padding: "5px 8px",
                            background: "#10b981",
                            border: "none",
                            borderRadius: 4,
                            color: "#fff",
                            cursor: "pointer",
                            fontSize: 9,
                            fontWeight: 700,
                            width: "100%"
                          }}
                        >
                          Execute Trade
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              {!loadingSignals && signals.length === 0 && (() => {
                console.log("🚨 EMPTY STATE TRIGGERED");
                const ss = getAlpacaAIScanStatus();
                return (
                  <div style={{ fontSize: 9, color: '#475569', padding: '8px 6px' }}>
                    <div style={{ textAlign: 'center', marginBottom: 4 }}>No qualifying live Alpaca AI signals yet.</div>
                    {ss.reviewed > 0 && (
                      <div style={{ fontFamily: 'monospace', fontSize: 8, color: '#334155', display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span>reviewed={ss.reviewed}  qualified={ss.qualified}  rejected={ss.rejected}</span>
                        <span style={{ color: '#ef4444' }}>{ss.message}</span>
                      </div>
                    )}
                  </div>
                );
              })()}
              {ruleChecks.map((rc, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', borderRadius: 4, background: rc.pass ? 'rgba(16,185,129,.05)' : 'rgba(239,68,68,.05)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: rc.pass ? '#10b981' : '#ef4444', display: 'flex' }}>{rc.pass ? <Ic.Check /> : <Ic.X />}</span>
                    <span style={{ fontSize: 9, color: rc.pass ? '#94a3b8' : '#f87171' }}>{rc.rule}</span>
                  </div>
                  {rc.value && <span style={{ fontSize: 8, color: '#475569', fontFamily: 'monospace' }}>{rc.value}</span>}
                </div>
              ))}
              {!ruleChecks.length && <div style={{ fontSize: 9, color: '#475569', textAlign: 'center', padding: '8px 0' }}>Waiting for signals…</div>}
            </div>
          </div>

          {/* ── Claude Advisor Panel ── */}
          <div style={S.panel('#38bdf8')}>
            <div style={S.top('#38bdf8')} />
            <div style={S.ph}>
              <span style={S.pt}><Ic.Brain /> Claude Advisor</span>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                {claudeResult && (
                  <Badge
                    label={claudeResult.evaluation.advisoryDecision}
                    color={claudeResult.evaluation.advisoryDecision === 'APPROVE' ? '#10b981' : claudeResult.evaluation.advisoryDecision === 'REJECT' ? '#ef4444' : '#f59e0b'}
                    bg={claudeResult.evaluation.advisoryDecision === 'APPROVE' ? 'rgba(16,185,129,.12)' : claudeResult.evaluation.advisoryDecision === 'REJECT' ? 'rgba(239,68,68,.12)' : 'rgba(245,158,11,.12)'}
                    border={claudeResult.evaluation.advisoryDecision === 'APPROVE' ? 'rgba(16,185,129,.3)' : claudeResult.evaluation.advisoryDecision === 'REJECT' ? 'rgba(239,68,68,.3)' : 'rgba(245,158,11,.3)'}
                  />
                )}
                <Badge
                  label={claudeResult ? 'Connected' : 'Idle'}
                  color={claudeResult ? '#38bdf8' : '#475569'}
                  bg={claudeResult ? 'rgba(56,189,248,.12)' : 'rgba(100,116,139,.1)'}
                  border={claudeResult ? 'rgba(56,189,248,.3)' : 'rgba(100,116,139,.3)'}
                />
              </div>
            </div>
            <div style={S.pb}>

              {/* Run dry-run button */}
              <button
                type="button"
                onClick={handleClaudeDryRun}
                disabled={claudeRunning}
                style={{ width: '100%', padding: '8px', fontSize: 10, fontWeight: 700, borderRadius: 5, border: '1px solid rgba(56,189,248,.4)', cursor: claudeRunning ? 'not-allowed' : 'pointer', background: claudeRunning ? 'rgba(56,189,248,.05)' : 'rgba(56,189,248,.1)', color: claudeRunning ? '#475569' : '#38bdf8', letterSpacing: '.06em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 10, opacity: claudeRunning ? 0.6 : 1 }}
              >
                {claudeRunning ? <><Ic.Spin on />&nbsp;Evaluating…</> : <><Ic.Play /> Run Claude Advisory Test (Dry Run)</>}
              </button>

              {/* Error */}
              {claudeError && (
                <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.25)', borderRadius: 5, padding: '7px 10px', fontSize: 9, color: '#f87171', marginBottom: 8, display: 'flex', gap: 6 }}>
                  <Ic.Alert /> {claudeError}
                </div>
              )}

              {/* Claude result */}
              {claudeResult && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{ fontSize: 9, color: '#475569' }}>
                    Last evaluated: {new Date(claudeResult.evaluatedAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET
                    &nbsp;·&nbsp;Model: {claudeResult.model}
                  </div>

                  {/* Trade thesis */}
                  <div style={{ background: '#1e293b', borderRadius: 5, padding: '8px 10px' }}>
                    <div style={{ fontSize: 8, color: '#475569', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 4 }}>Trade Thesis</div>
                    <div style={{ fontSize: 10, color: '#e2e8f0', lineHeight: 1.5 }}>{claudeResult.evaluation.tradeThesis}</div>
                  </div>

                  {/* Confidence commentary */}
                  <div style={{ background: '#1e293b', borderRadius: 5, padding: '8px 10px' }}>
                    <div style={{ fontSize: 8, color: '#475569', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 4 }}>Confidence Commentary</div>
                    <div style={{ fontSize: 10, color: '#94a3b8', lineHeight: 1.5 }}>{claudeResult.evaluation.confidenceCommentary}</div>
                  </div>

                  {/* Risk notes */}
                  {claudeResult.evaluation.riskNotes.length > 0 && (
                    <div style={{ background: 'rgba(245,158,11,.06)', border: '1px solid rgba(245,158,11,.2)', borderRadius: 5, padding: '8px 10px' }}>
                      <div style={{ fontSize: 8, color: '#f59e0b', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 5 }}>Risk Notes</div>
                      {claudeResult.evaluation.riskNotes.map((n, i) => (
                        <div key={i} style={{ fontSize: 9, color: '#fbbf24', marginBottom: 2, display: 'flex', gap: 5 }}>
                          <span style={{ color: '#f59e0b', flexShrink: 0 }}>·</span>{n}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Conflicting signals */}
                  {claudeResult.evaluation.conflictingSignals.length > 0 && (
                    <div style={{ background: 'rgba(239,68,68,.06)', border: '1px solid rgba(239,68,68,.2)', borderRadius: 5, padding: '8px 10px' }}>
                      <div style={{ fontSize: 8, color: '#ef4444', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 5 }}>Conflicting Signals</div>
                      {claudeResult.evaluation.conflictingSignals.map((c, i) => (
                        <div key={i} style={{ fontSize: 9, color: '#f87171', marginBottom: 2, display: 'flex', gap: 5 }}>
                          <span style={{ flexShrink: 0 }}>·</span>{c}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Dry-run result */}
              {dryRunResult && (
                <div style={{ marginTop: 8, background: '#1e293b', borderRadius: 5, padding: '8px 10px' }}>
                  <div style={{ fontSize: 8, color: '#475569', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', marginBottom: 6 }}>Risk Engine + Execution Gate (Dry Run)</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {[
                      { label: 'Signal Stack', pass: dryRunResult.executionGate.signalStackPassed },
                      { label: 'Claude APPROVE', pass: dryRunResult.executionGate.claudeApproved },
                      { label: 'Risk Engine', pass: dryRunResult.executionGate.riskDecisionApproved },
                      { label: 'Shadow Mode OFF', pass: dryRunResult.executionGate.shadowModeOff },
                      { label: 'Live Trading ON', pass: dryRunResult.executionGate.liveTradingEnabled },
                      { label: 'Auto-Trade ON', pass: dryRunResult.executionGate.autoTradeEnabled },
                      { label: 'User Confirmed', pass: dryRunResult.executionGate.liveAutoTradeConfirmed },
                    ].map(({ label, pass }) => (
                      <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ color: pass ? '#10b981' : '#475569', display: 'flex', flexShrink: 0 }}>{pass ? <Ic.Check /> : <Ic.X />}</span>
                        <span style={{ fontSize: 9, color: pass ? '#94a3b8' : '#475569' }}>{label}</span>
                      </div>
                    ))}
                  </div>
                  <div style={{ marginTop: 7, padding: '5px 8px', borderRadius: 4, background: dryRunResult.executionGate.canExecute ? 'rgba(16,185,129,.1)' : 'rgba(100,116,139,.1)', border: `1px solid ${dryRunResult.executionGate.canExecute ? 'rgba(16,185,129,.3)' : 'rgba(100,116,139,.3)'}` }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: dryRunResult.executionGate.canExecute ? '#34d399' : '#64748b' }}>
                      {dryRunResult.executionGate.canExecute ? 'WOULD EXECUTE' : `WOULD BLOCK — ${dryRunResult.executionGate.blockedReasons[0] ?? 'see above'}`}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 8, color: '#334155', lineHeight: 1.4, fontStyle: 'italic' }}>
                    DRY RUN — no order was submitted
                  </div>
                </div>
              )}

              {/* No result yet */}
              {!claudeResult && !claudeRunning && !claudeError && (
                <div style={{ fontSize: 9, color: '#334155', textAlign: 'center', padding: '8px 0' }}>
                  Press the button above to run a dry-run advisory test.
                </div>
              )}
            </div>
          </div>

        </div>

        {/* ═══ MIDDLE COLUMN ═══ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Auto-Trading Control Panel */}
          <div style={S.panel(liveTradingEnabled ? '#ef4444' : '#475569')}>
            <div style={S.top(liveTradingEnabled ? '#ef4444' : '#475569')} />
            <div style={S.ph}>
              <span style={S.pt}><Ic.Bolt /> Auto-Trading Controls</span>
              <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <Badge label={inWindow ? 'MARKET OPEN' : 'CLOSED'} color={inWindow ? '#10b981' : '#64748b'} bg={inWindow ? 'rgba(16,185,129,.1)' : 'rgba(100,116,139,.1)'} border={inWindow ? 'rgba(16,185,129,.3)' : 'rgba(100,116,139,.3)'} />
              </div>
            </div>
            <div style={S.pb}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

                {/* Shadow mode */}
                <ControlRow
                  label="Shadow Mode"
                  sub="Log signals without placing real orders"
                  badge={shadowMode ? <Badge label="ON — NO ORDERS" color="#f59e0b" bg="rgba(245,158,11,.1)" border="rgba(245,158,11,.3)" /> : <Badge label="OFF" color="#64748b" bg="rgba(100,116,139,.1)" border="rgba(100,116,139,.3)" />}
                >
                  <Toggle on={shadowMode} onChange={setShadowMode} />
                </ControlRow>

                <div style={{ height: 1, background: '#1e293b' }} />

                {/* Live trading enabled */}
                <ControlRow label="Live Trading Enabled" sub={isConnected ? 'Allow limit orders to be submitted' : 'Connect account first'}>
                  <Toggle on={liveTradingEnabled} onChange={handleLiveTradingToggle} disabled={!isConnected} />
                </ControlRow>

                {liveTradingEnabled && !shadowMode && (
                  <div style={{ background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.25)', borderRadius: 5, padding: '7px 10px', fontSize: 9, color: '#fca5a5', display: 'flex', gap: 7 }}>
                    <Ic.Alert /> Live trading is ON and shadow mode is OFF. Real orders can be placed.
                  </div>
                )}

                <div style={{ height: 1, background: '#1e293b' }} />

                {/* Auto-trade enabled */}
                <ControlRow label="Auto-Trade Enabled" sub={!liveTradingEnabled ? 'Requires Live Trading Enabled' : 'Execute signals without manual approval'}>
                  <Toggle on={autoTradeEnabled} onChange={handleAutoTradeToggle} disabled={!liveTradingEnabled} />
                </ControlRow>

                <div style={{ height: 1, background: '#1e293b' }} />

                {/* Kill switch */}
                {!killConfirm ? (
                  <button type="button" onClick={() => setKillConfirm(true)}
                    style={{ width: '100%', padding: '8px', fontSize: 10, fontWeight: 700, borderRadius: 5, border: '1px solid rgba(239,68,68,.5)', cursor: 'pointer', background: 'rgba(239,68,68,.12)', color: '#f87171', letterSpacing: '.06em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    <Ic.Stop /> Emergency Kill Switch
                  </button>
                ) : (
                  <div style={{ background: 'rgba(239,68,68,.1)', border: '1px solid rgba(239,68,68,.4)', borderRadius: 5, padding: '10px' }}>
                    <div style={{ fontSize: 10, color: '#fca5a5', fontWeight: 700, marginBottom: 8, textAlign: 'center' }}>Confirm: disable all auto-trading?</div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" onClick={handleKillSwitch} style={{ flex: 1, padding: '6px', fontSize: 10, fontWeight: 700, borderRadius: 4, border: 'none', background: '#ef4444', color: '#fff', cursor: 'pointer' }}>Confirm Kill</button>
                      <button type="button" onClick={() => setKillConfirm(false)} style={{ flex: 1, padding: '6px', fontSize: 10, fontWeight: 700, borderRadius: 4, border: '1px solid #334155', background: 'transparent', color: '#64748b', cursor: 'pointer' }}>Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Daily P&L / Risk gauges */}
          <div style={S.panel('#8b5cf6')}>
            <div style={S.top('#8b5cf6')} />
            <div style={S.ph}><span style={S.pt}>Daily Risk Dashboard</span></div>
            <div style={S.pb}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

                <RiskGauge label="Daily P&L" value={`${dailyPct >= 0 ? '+' : ''}${dailyPct.toFixed(2)}%`}
                  sub={`$${riskState.dailyPnl.toFixed(2)}`}
                  pct={Math.abs(dailyPct)} max={targetPct}
                  color={riskState.dailyPnl >= 0 ? '#10b981' : '#ef4444'} />

                <RiskGauge label="Daily Target" value={`+${targetPct}%`}
                  sub={`≈ $${liveAccount ? (liveAccount.equity * RISK_CONFIG.DAILY_TARGET_PCT).toFixed(2) : '—'}`}
                  pct={(dailyPct / targetPct) * 100} max={100}
                  color='#10b981' done={riskState.dailyTargetReached} />

                <RiskGauge label="Max Daily Loss" value={`-${lossPct}%`}
                  sub={`≈ $${liveAccount ? (liveAccount.equity * RISK_CONFIG.MAX_DAILY_LOSS_PCT).toFixed(2) : '—'}`}
                  pct={Math.max(0, (-dailyPct / lossPct) * 100)} max={100}
                  color='#ef4444' done={riskState.tradingDisabled} />

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginTop: 4 }}>
                  <StatBox label="Trades Today"   value={`${riskState.tradesToday}/${RISK_CONFIG.MAX_TRADES_PER_DAY}`} color='#38bdf8' />
                  <StatBox label="Consec. Losses" value={`${riskState.consecutiveLosses}/${RISK_CONFIG.MAX_CONSECUTIVE_LOSSES}`} color={riskState.consecutiveLosses >= RISK_CONFIG.MAX_CONSECUTIVE_LOSSES ? '#ef4444' : '#f59e0b'} />
                  <StatBox label="Open Positions" value={`${positions.length}/${RISK_CONFIG.MAX_OPEN_POSITIONS}`} color='#a78bfa' />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 9, color: '#475569', marginTop: 2 }}>
                  <Ic.Clock /> ET: {getEasternTimeString()} — Window: {inWindow ? <span style={{ color: '#10b981' }}>OPEN</span> : <span style={{ color: '#ef4444' }}>CLOSED</span>}
                </div>
              </div>
            </div>
          </div>

          {/* Positions */}
          {isConnected && positions.length > 0 && (
            <div style={S.panel('#14b8a6')}>
              <div style={S.top('#14b8a6')} />
              <div style={S.ph}><span style={S.pt}>Open Positions</span><span style={{ fontSize: 9, color: '#475569' }}>{positions.length}</span></div>
              <div style={S.pb}>
                {positions.map((p, i) => (
                  <div key={i} style={{ ...S.row, padding: '5px 0' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#e2e8f0' }}>{p.symbol}</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 9, color: '#64748b' }}>x{p.qty}</span>
                      <span style={{ fontSize: 10, color: p.unrealizedPL >= 0 ? '#34d399' : '#f87171', fontFamily: 'monospace' }}>
                        {p.unrealizedPL >= 0 ? '+' : ''}{p.unrealizedPL.toFixed(2)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* ═══ RIGHT COLUMN ═══ */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Trading window status */}
          <div style={S.panel(inWindow ? '#10b981' : '#334155')}>
            <div style={S.top(inWindow ? '#10b981' : '#334155')} />
            <div style={S.ph}><span style={S.pt}><Ic.Clock /> Trading Window</span></div>
            <div style={S.pb}>
              <div style={{ textAlign: 'center', padding: '8px 0' }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: inWindow ? '#10b981' : '#475569', fontFamily: 'monospace' }}>
                  {inWindow ? 'OPEN' : 'CLOSED'}
                </div>
                <div style={{ fontSize: 9, color: '#475569', marginTop: 4 }}>9:35 AM – 3:55 PM ET · Mon–Fri</div>
                <div style={{ fontSize: 10, color: '#64748b', marginTop: 6, fontFamily: 'monospace' }}>{getEasternTimeString()}</div>
              </div>
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <WindowTime label="Pre-open"    time="9:00–9:35 AM ET"  active={false} />
                <WindowTime label="Active"      time="9:35–3:55 PM ET"  active={inWindow} />
                <WindowTime label="Wind-down"   time="3:55–5:00 PM ET"  active={false} />
              </div>
            </div>
          </div>

          {/* Risk config reference */}
          <div style={S.panel('#0ea5e9')}>
            <div style={S.top('#0ea5e9')} />
            <div style={S.ph}><span style={S.pt}>Risk Config</span></div>
            <div style={S.pb}>
              {[
                ['Max trades/day',    String(RISK_CONFIG.MAX_TRADES_PER_DAY)],
                ['Max contracts',     String(RISK_CONFIG.MAX_CONTRACTS)],
                ['Max positions',     String(RISK_CONFIG.MAX_OPEN_POSITIONS)],
                ['Risk/trade',        `${RISK_CONFIG.MAX_RISK_PER_TRADE_PCT * 100}% equity`],
                ['Max daily loss',    `${RISK_CONFIG.MAX_DAILY_LOSS_PCT * 100}% equity`],
                ['Daily target',      `+${RISK_CONFIG.DAILY_TARGET_PCT * 100}% equity`],
                ['Consec. losses',    String(RISK_CONFIG.MAX_CONSECUTIVE_LOSSES)],
                ['Order type',        'Limit only'],
                ['Time in force',     'Day'],
                ['Order timeout',     '5 min'],
                ['Loop interval',     '5 min'],
              ].map(([l, v]) => (
                <div key={l} style={{ ...S.row, padding: '5px 0' }}>
                  <span style={{ fontSize: 9, color: '#475569' }}>{l}</span>
                  <span style={{ fontSize: 9, color: '#94a3b8', fontFamily: 'monospace' }}>{v}</span>
                </div>
              ))}
            </div>
          </div>

        </div>
      </div>

      {/* ── Account Monitor Panel ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>

        <div style={S.panel('#10b981')}>
          <div style={S.top('#10b981')} />
          <div style={S.ph}>
            <span style={S.pt}><Ic.Wallet /> Account Monitor</span>
            <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              {fetchingAcct && <Ic.Spin on />}
              {acctStateError && <Badge label="ERROR" color="#ef4444" bg="rgba(239,68,68,.1)" border="rgba(239,68,68,.3)" />}
            </div>
          </div>
          <div style={S.pb}>
            {acctStateError && (
              <div style={{ fontSize: 9, color: '#f87171', marginBottom: 8, display: 'flex', gap: 5 }}><Ic.Alert />{acctStateError}</div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
              <AccountMetric
                label="Buying Power"
                value={acctState ? `$${acctState.buyingPower.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                color="#10b981"
                sub="Available now"
              />
              <AccountMetric
                label="Equity"
                value={acctState ? `$${acctState.equity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                color="#38bdf8"
                sub="Total equity"
              />
              <AccountMetric
                label="Portfolio Value"
                value={acctState ? `$${acctState.portfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                color="#a78bfa"
                sub="Market value"
              />
            </div>

            {/* Pre/Post trade buying power comparison */}
            <div style={{ background: '#1e293b', borderRadius: 6, padding: '10px' }}>
              <div style={{ fontSize: 8, color: '#475569', fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', marginBottom: 8 }}>
                Buying Power — Last Trade
              </div>
              <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 8, color: '#475569', marginBottom: 2 }}>Pre-Trade</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8', fontFamily: 'monospace' }}>
                    {preTradeBP !== null ? `$${preTradeBP.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                  </div>
                </div>
                <div style={{ color: '#334155', fontSize: 16 }}>→</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 8, color: '#475569', marginBottom: 2 }}>Post-Trade</div>
                  <div style={{ fontSize: 12, fontWeight: 700, fontFamily: 'monospace', color: postTradeBP !== null && preTradeBP !== null && postTradeBP < preTradeBP ? '#f87171' : '#34d399' }}>
                    {postTradeBP !== null ? `$${postTradeBP.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                  </div>
                </div>
                {preTradeBP !== null && postTradeBP !== null && (
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 8, color: '#475569', marginBottom: 2 }}>Δ Used</div>
                    <div style={{ fontSize: 11, fontWeight: 700, fontFamily: 'monospace', color: '#f59e0b' }}>
                      {postTradeBP < preTradeBP ? '-' : '+'}${Math.abs(preTradeBP - postTradeBP).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* BP safety reserve indicator */}
            {acctState && (
              <div style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                  <span style={{ fontSize: 8, color: '#475569' }}>Reserve Floor ({`$${MIN_BUYING_POWER_RESERVE}`})</span>
                  <span style={{ fontSize: 8, color: acctState.buyingPower < MIN_BUYING_POWER_RESERVE * 2 ? '#ef4444' : '#10b981' }}>
                    {acctState.buyingPower >= MIN_BUYING_POWER_RESERVE ? 'SAFE' : 'BELOW RESERVE'}
                  </span>
                </div>
                <div style={{ background: '#0f172a', borderRadius: 99, overflow: 'hidden', height: 3 }}>
                  <div style={{
                    height: 3, borderRadius: 99, transition: 'width .4s',
                    width: `${Math.min(100, (acctState.buyingPower / (acctState.equity || 1)) * 100)}%`,
                    background: acctState.buyingPower < MIN_BUYING_POWER_RESERVE ? '#ef4444' : '#10b981',
                  }} />
                </div>
              </div>
            )}

            <div style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 8, color: '#334155' }}>
                {acctState ? `Last fetched: ${new Date(acctState.lastFetched).toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET` : 'Not fetched yet'}
              </span>
              <span style={{ fontSize: 8, color: '#334155' }}>·</span>
              <span style={{ fontSize: 8, color: '#334155' }}>Open positions: {acctState?.openPositionsCount ?? '—'}</span>
              {activeExecId && (
                <Badge label="ORDER IN FLIGHT" color="#f59e0b" bg="rgba(245,158,11,.1)" border="rgba(245,158,11,.3)" />
              )}
            </div>
          </div>
        </div>

        {/* ── Execution Status Panel ── */}
        <div style={S.panel('#0ea5e9')}>
          <div style={S.top('#0ea5e9')} />
          <div style={S.ph}>
            <span style={S.pt}><Ic.List /> Execution Status</span>
            <div style={{ display: 'flex', gap: 5 }}>
              {activeExecId && <><Ic.Spin on /><span style={{ fontSize: 9, color: '#f59e0b' }}>In flight…</span></>}
              <span style={{ fontSize: 9, color: '#475569' }}>{execRecords.length} records</span>
            </div>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {execRecords.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', fontSize: 9, color: '#334155' }}>
                No execution records yet. Trades appear here as they progress through the lifecycle.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                {execRecords.map((rec, i) => (
                  <ExecRecordRow key={rec.id} rec={rec} index={i} />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Trade Log ── */}
      <div style={S.panel('#334155')}>
        <div style={S.top('#334155')} />
        <div style={S.ph}>
          <span style={S.pt}>Trade Log</span>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {submitting && <><Ic.Spin on /> <span style={{ fontSize: 9, color: '#f59e0b' }}>Submitting…</span></>}
            <span style={{ fontSize: 9, color: '#475569' }}>{tradeLog.length} entries</span>
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          {tradeLog.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', fontSize: 10, color: '#334155' }}>
              No trade decisions logged yet. Enable auto-trading during market hours to begin.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 9 }}>
              <thead>
                <tr style={{ background: '#1e293b' }}>
                  {['Time', 'Ticker', 'Option Symbol', 'Score', 'Conf', 'R/R', 'Grade', 'Price', 'Qty', 'Status', 'Reason / Order'].map(h => (
                    <th key={h} style={{ padding: '5px 8px', textAlign: 'left', color: '#475569', fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {tradeLog.map((t, i) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #1e293b', background: i % 2 === 0 ? 'transparent' : 'rgba(30,41,59,.3)' }}>
                    <td style={{ padding: '5px 8px', color: '#475569', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{new Date(t.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                    <td style={{ padding: '5px 8px', color: '#e2e8f0', fontWeight: 700 }}>{t.ticker}</td>
                    <td style={{ padding: '5px 8px', color: '#64748b', fontFamily: 'monospace', fontSize: 8 }}>{t.optionSymbol}</td>
                    <td style={{ padding: '5px 8px', color: '#f1f5f9', fontFamily: 'monospace' }}>{t.signalScore}/20</td>
                    <td style={{ padding: '5px 8px', color: '#38bdf8' }}>{t.confidence}%</td>
                    <td style={{ padding: '5px 8px', color: '#f59e0b' }}>1:{t.riskReward}</td>
                    <td style={{ padding: '5px 8px' }}><StatusBadge v={t.grade.toLowerCase()} /></td>
                    <td style={{ padding: '5px 8px', color: '#34d399', fontFamily: 'monospace' }}>{t.entryPrice ? `$${t.entryPrice}` : '—'}</td>
                    <td style={{ padding: '5px 8px', color: '#94a3b8' }}>{t.qty}</td>
                    <td style={{ padding: '5px 8px' }}><StatusBadge v={t.status} /></td>
                    <td style={{ padding: '5px 8px', color: '#475569', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.orderId ? <span style={{ color: '#38bdf8', fontFamily: 'monospace' }}>{t.orderId}</span> : (t.rejectionReason || '—')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helper sub-components ─────────────────────────────────────────────────────

function ControlRow({ label, sub, badge, children }: { label: string; sub: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, color: '#cbd5e1', display: 'flex', alignItems: 'center', gap: 6 }}>{label}{badge}</div>
        <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>{sub}</div>
      </div>
      {children}
    </div>
  );
}


function MiniMetric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: '#0f172a', border: `1px solid ${color}22`, borderRadius: 4, padding: '4px 5px' }}>
      <div style={{ fontSize: 7, color: '#475569', marginBottom: 1, textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 9, color, fontWeight: 700, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function RiskGauge({ label, value, sub, pct, max, color, done }: { label: string; value: string; sub: string; pct: number; max: number; color: string; done?: boolean }) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 9, color: '#64748b' }}>{label}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ fontSize: 9, color: '#94a3b8' }}>{sub}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color, fontFamily: 'monospace' }}>{value}</span>
          {done && <Badge label="DONE" color={color} bg={`${color}18`} border={`${color}44`} />}
        </div>
      </div>
      <PnlBar pct={(pct / max) * 100} color={color} />
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ background: '#1e293b', border: `1px solid ${color}22`, borderRadius: 5, padding: '6px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 8, color: '#475569', marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: 'monospace' }}>{value}</div>
    </div>
  );
}

function WindowTime({ label, time, active }: { label: string; time: string; active: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', borderRadius: 4, background: active ? 'rgba(16,185,129,.08)' : 'transparent', border: active ? '1px solid rgba(16,185,129,.2)' : '1px solid transparent' }}>
      <span style={{ fontSize: 9, color: active ? '#34d399' : '#475569', fontWeight: active ? 700 : 400 }}>{label}</span>
      <span style={{ fontSize: 8, color: '#475569', fontFamily: 'monospace' }}>{time}</span>
    </div>
  );
}

function AccountMetric({ label, value, color, sub }: { label: string; value: string; color: string; sub: string }) {
  return (
    <div style={{ background: '#1e293b', borderRadius: 6, padding: '8px 10px', border: `1px solid ${color}18` }}>
      <div style={{ fontSize: 8, color: '#475569', marginBottom: 3, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 700, color, fontFamily: 'monospace', marginBottom: 1 }}>{value}</div>
      <div style={{ fontSize: 7, color: '#334155' }}>{sub}</div>
    </div>
  );
}

const ORDER_STATUS_COLORS: Record<string, [string, string]> = {
  submitted:        ['#38bdf8', 'rgba(56,189,248,.12)'],
  partially_filled: ['#f59e0b', 'rgba(245,158,11,.12)'],
  filled:           ['#10b981', 'rgba(16,185,129,.12)'],
  canceled:         ['#64748b', 'rgba(100,116,139,.12)'],
  rejected:         ['#ef4444', 'rgba(239,68,68,.12)'],
  shadow:           ['#f59e0b', 'rgba(245,158,11,.12)'],
  blocked:          ['#475569', 'rgba(71,85,105,.12)'],
  pending_cancel:   ['#f87171', 'rgba(248,113,113,.12)'],
  expired:          ['#64748b', 'rgba(100,116,139,.12)'],
};

function ExecRecordRow({ rec, index }: { rec: ExecutionRecord; index: number }) {
  const [col, bg] = ORDER_STATUS_COLORS[rec.orderStatus] ?? ['#64748b', 'rgba(100,116,139,.12)'];
  const isActive = !['filled', 'canceled', 'rejected', 'blocked', 'shadow', 'expired'].includes(rec.orderStatus);

  return (
    <div style={{ padding: '8px 13px', borderBottom: '1px solid #1e293b', background: index % 2 === 0 ? 'transparent' : 'rgba(15,23,42,.4)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 3 }}>
            <span style={{ fontWeight: 700, color: '#f1f5f9', fontSize: 11 }}>{rec.ticker}</span>
            <span style={{ fontSize: 7, color: '#475569', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>{rec.optionSymbol}</span>
            {isActive && <Ic.Spin on />}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            <span style={{ fontSize: 7, ...S.badge(col, bg, `${col}44`) }}>{rec.orderStatus.replace('_', ' ').toUpperCase()}</span>
            {rec.fillStatus !== 'pending' && (
              <span style={{ fontSize: 7, ...S.badge(rec.fillStatus === 'filled' ? '#10b981' : '#64748b', rec.fillStatus === 'filled' ? 'rgba(16,185,129,.1)' : 'rgba(100,116,139,.1)', rec.fillStatus === 'filled' ? 'rgba(16,185,129,.3)' : 'rgba(100,116,139,.3)') }}>
                FILL: {rec.fillStatus.toUpperCase()}
              </span>
            )}
            <span style={{ fontSize: 7, ...S.badge(rec.positionConfirmed ? '#10b981' : '#475569', rec.positionConfirmed ? 'rgba(16,185,129,.1)' : 'rgba(71,85,105,.1)', rec.positionConfirmed ? 'rgba(16,185,129,.3)' : 'rgba(71,85,105,.3)') }}>
              POS: {rec.positionConfirmed ? 'CONFIRMED' : 'PENDING'}
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: '#34d399', fontFamily: 'monospace' }}>
            ${(rec.limitPrice ?? 0).toFixed(2)}
          </div>
          <div style={{ fontSize: 8, color: '#475569' }}>x{rec.quantity} · ${rec.estimatedCost?.toFixed(0) ?? '—'} est.</div>
        </div>
      </div>

      {/* BP row */}
      <div style={{ display: 'flex', gap: 12, marginTop: 5 }}>
        {rec.preTradeBuyingPower !== null && (
          <span style={{ fontSize: 8, color: '#475569' }}>
            BP: <span style={{ color: '#94a3b8', fontFamily: 'monospace' }}>${rec.preTradeBuyingPower?.toFixed(0)}</span>
            {rec.postTradeBuyingPower !== null && (
              <> → <span style={{ color: rec.postTradeBuyingPower < (rec.preTradeBuyingPower ?? 0) ? '#f87171' : '#34d399', fontFamily: 'monospace' }}>${rec.postTradeBuyingPower.toFixed(0)}</span></>
            )}
          </span>
        )}
        {rec.orderId && (
          <span style={{ fontSize: 7, color: '#334155', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>ID: {rec.orderId.slice(0, 12)}…</span>
        )}
        {rec.submittedAt && (
          <span style={{ fontSize: 7, color: '#334155' }}>
            {new Date(rec.submittedAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })} ET
          </span>
        )}
      </div>

      {/* Blocked reason */}
      {rec.blockedReason && (
        <div style={{ fontSize: 8, color: '#f87171', marginTop: 3, display: 'flex', gap: 4 }}>
          <Ic.X />{rec.blockedReason}
        </div>
      )}
      {/* Fill confirmation */}
      {rec.filledAt && (
        <div style={{ fontSize: 8, color: '#34d399', marginTop: 3, display: 'flex', gap: 4 }}>
          <Ic.Check />Filled at {new Date(rec.filledAt).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' })} ET
        </div>
      )}
    </div>
  );
}
