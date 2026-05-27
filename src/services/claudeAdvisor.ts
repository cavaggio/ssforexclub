// ── Claude Advisory Service ───────────────────────────────────────────────────
// All Claude calls are proxied through the Supabase Edge Function so the
// ANTHROPIC_API_KEY never touches the browser bundle.

import type { TradeSignal } from './alpacaLiveTrading';
import { CLAUDE_API_BASE as API_BASE_URL } from '../lib/apiBase';

// ── Types ─────────────────────────────────────────────────────────────────────

export type AdvisoryDecision = 'APPROVE' | 'CAUTION' | 'REJECT';

export type ClaudeTradeEvaluation = {
  advisoryDecision: AdvisoryDecision;
  momentumStrength: number;    // 1-10
  repeatabilityScore: number;  // 1-10
  tradeThesis: string;
  exitPlan: string;
  riskNotes: string[];
  conflictingSignals: string[];
  confidenceCommentary: string;
};

export type ClaudeRankedSignal = ClaudeTradeEvaluation & {
  ticker: string;
  rank: number;
};

export type ClaudeRankingResult = {
  ranked: ClaudeRankedSignal[];
  summary: string;
};

export type ClaudeEvaluationResult = {
  evaluation: ClaudeTradeEvaluation;
  rawText: string;
  model: string;
  evaluatedAt: string;
};

export type MarketContext = {
  spyTrend?: string;
  vixLevel?: string;
  putCallRatio?: string;
  sentiment?: string;
};

// ── Sanitizer — strips everything except market-safe fields ──────────────────
// Ensures no account data, no credentials, and no internal state leaks to Claude.

function sanitizeSignal(signal: TradeSignal): Record<string, unknown> {
  return {
    ticker:          signal.ticker,
    optionSymbol:    signal.optionSymbol,
    totalScore:      signal.totalScore,
    confidence:      signal.confidence,
    grade:           signal.grade,
    riskReward:      signal.riskReward,
    marketAlignment: signal.marketAlignment,
    bias:            signal.bias,
    entry:           signal.entry,
    stop:            signal.stop,
    target:          signal.target,
    catalyst:        signal.catalyst ?? 'Not specified',
  };
}

// ── Raw shape returned by the edge function ───────────────────────────────────

type RawEvaluation = {
  decision: string;
  confidence: number;
  reasoning: string;
  keyRisks: string[];
  recommendation: string;
};

function mapEvaluation(raw: RawEvaluation): ClaudeTradeEvaluation {
  return {
    advisoryDecision:      (raw.decision ?? 'CAUTION') as AdvisoryDecision,
    momentumStrength:      (raw as any).momentumStrength ?? 5,
    repeatabilityScore:    (raw as any).repeatabilityScore ?? 5,
    tradeThesis:           raw.reasoning ?? '',
    exitPlan:              (raw as any).exitPlan ?? raw.recommendation ?? '',
    riskNotes:             raw.keyRisks ?? [],
    conflictingSignals:    [],
    confidenceCommentary:  raw.recommendation ?? '',
  };
}

// ── API helper ────────────────────────────────────────────────────────────────

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

// ── Public API ────────────────────────────────────────────────────────────────

export const claudeAdvisor = {

  /**
   * Evaluate a single trade signal with Claude.
   * Sends only sanitized, non-sensitive market data to the backend.
   * The backend adds the ANTHROPIC_API_KEY from process.env.
   */
  async evaluateTradeWithClaude(
    signal: TradeSignal,
    marketContext: MarketContext = {},
  ): Promise<ClaudeEvaluationResult> {
    const score      = signal.totalScore ?? 0;
    const confidence = signal.confidence ?? 0;

    // Change 6 — debug log
    console.log("SIGNAL METRICS:", { score, confidence });

    // Changes 4 & 5 — local pre-flight decision based on score + confidence only.
    // Avoids API calls when the answer is clear, and does not block on missing
    // optional fields (entry price, stop, target).
    if (score >= 14 && confidence >= 65) {
      console.log("CLAUDE PRE-FLIGHT: APPROVE (score:", score, "conf:", confidence, ")");
      return {
        evaluation: {
          advisoryDecision:   'APPROVE',
          momentumStrength:   Math.round(score / 2),
          repeatabilityScore: Math.round(confidence / 10),
          tradeThesis:        'High probability repeatable setup',
          exitPlan:           'Exit at target or stop',
          riskNotes:          [],
          conflictingSignals: [],
          confidenceCommentary: `Score ${score}/20 and confidence ${confidence}% meet thresholds`,
        },
        rawText:     '',
        model:       'local-preflight',
        evaluatedAt: new Date().toISOString(),
      };
    }

    console.log("CLAUDE PRE-FLIGHT: calling API (score:", score, "conf:", confidence, ")");

    // Marginal signals — delegate to Claude API
    try {
      const raw = await post<{ evaluation: RawEvaluation; rawText: string; model: string }>(
        '/api/claude/evaluate',
        { signal: sanitizeSignal(signal), marketContext },
      );
      return {
        evaluation:  mapEvaluation(raw.evaluation),
        rawText:     raw.rawText ?? '',
        model:       raw.model ?? '',
        evaluatedAt: new Date().toISOString(),
      };
    } catch {
      // API unavailable — return REJECT rather than throwing
      return {
        evaluation: {
          advisoryDecision:   'REJECT',
          momentumStrength:   0,
          repeatabilityScore: 0,
          tradeThesis:        'Below confidence or score threshold',
          exitPlan:           '',
          riskNotes:          [],
          conflictingSignals: [],
          confidenceCommentary: '',
        },
        rawText:     '',
        model:       'local-fallback',
        evaluatedAt: new Date().toISOString(),
      };
    }
  },

  /**
   * Rank multiple trade candidates and return ordered advisory.
   * Sends sanitized signals only — no account data, no credentials.
   */
  async rankTradeCandidatesWithClaude(
    signals: TradeSignal[],
    marketContext: MarketContext = {},
  ): Promise<ClaudeRankingResult & { evaluatedAt: string }> {
    const raw = await post<{ ranked: (RawEvaluation & { ticker: string })[]; summary: string }>(
      '/api/claude/rank',
      { signals: signals.map(sanitizeSignal), marketContext },
    );
    return {
      ranked: (raw.ranked ?? []).map((r, i) => ({
        ...mapEvaluation(r),
        ticker: r.ticker,
        rank:   i + 1,
      })),
      summary:     raw.summary ?? '',
      evaluatedAt: new Date().toISOString(),
    };
  },

  /**
   * Produce a human-readable summary of a completed trade decision.
   * Pure function — no network call needed.
   */
  summarizeTradeDecision(
    signal: TradeSignal,
    claudeEvaluation: ClaudeTradeEvaluation,
    riskDecision: { approved: boolean; blockedReason?: string },
  ): string {
    const decision = riskDecision.approved
      ? claudeEvaluation.advisoryDecision === 'APPROVE' ? 'SUBMITTED' : 'BLOCKED (Claude)'
      : `BLOCKED (Risk Engine: ${riskDecision.blockedReason ?? 'rule failed'})`;

    return [
      `[${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' })} ET]`,
      `${signal.ticker} ${signal.optionSymbol}`,
      `Score: ${signal.totalScore}/20 | Conf: ${signal.confidence}% | Grade: ${signal.grade}`,
      `Claude: ${claudeEvaluation.advisoryDecision} — ${claudeEvaluation.tradeThesis}`,
      `Decision: ${decision}`,
    ].join(' | ');
  },
};
