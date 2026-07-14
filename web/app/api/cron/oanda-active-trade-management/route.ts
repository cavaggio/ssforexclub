import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { resolveActiveBrokerForUser } from '@/lib/brokerResolver';
import { callInternalEndpoint } from '@/lib/scannerProxy';
import { syncOandaTransactionsForUser } from '@/lib/oandaTransactionSync';
import {
  decideAutoAiClose,
  inAutoAiManagementWindow,
} from '@/lib/autoAiActiveTradePolicy.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const mask = (id: string) => (id && id.length > 6 ? `${id.slice(0, 4)}…${id.slice(-2)}` : '***');

type ManagementPlan = {
  tradeId?: string;
  instrument?: string;
  error?: string;
  autoCloseAttempted?: boolean;
  autoCloseResult?: { ok?: boolean };
  invalidationDetected?: boolean;
  invalidationSeverity?: string;
  volatilityCollapsed?: boolean;
  volatilityCollapseSeverity?: string;
  trendWeakeningDetected?: boolean;
  trendWeakeningSeverity?: string;
  momentumStatus?: string;
  marketState?: string;
  liveTpConfidence?: {
    adjustments?: Array<{ label?: string; delta?: number | string }>;
  };
};

type ReassessResponse = {
  trades?: ManagementPlan[];
  meta?: {
    totalActive?: number;
    autoCloseResults?: Array<{
      tradeId?: string;
      instrument?: string;
      ok?: boolean;
      message?: string;
      error?: string | null;
    }>;
  };
};

export async function POST(req: Request) {
  const secret = process.env.AUTO_AI_CRON_SECRET;
  if (!secret || req.headers.get('x-cron-secret') !== secret) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const now = new Date();
  if (!inAutoAiManagementWindow(now)) {
    return NextResponse.json({
      ok: true,
      skipped: 'outside_active_trade_management_window',
      window: '02:15–17:05 America/New_York',
      users: 0,
    });
  }

  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('user_id')
    .eq('auto_ai_trading_enabled', true);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{ user_id: string }>;
  const results: Record<string, unknown>[] = [];
  let usersManaged = 0;
  let tradesReviewed = 0;
  let closeAttempts = 0;
  let closed = 0;
  let failed = 0;
  let transactionEventsLogged = 0;

  for (const row of rows) {
    const userId = row.user_id;

    try {
      const resolved = await resolveActiveBrokerForUser(userId);
      if (resolved.activeBroker !== 'oanda') {
        results.push({ user: mask(userId), skipped: 'not_oanda' });
        continue;
      }

      if (
        resolved.brokerCredentialStatus !== 'ready' ||
        !resolved.getCredentials ||
        !resolved.baseUrl
      ) {
        results.push({
          user: mask(userId),
          skipped: resolved.brokerCredentialStatus,
          reason: resolved.reason,
        });
        continue;
      }

      const creds = await resolved.getCredentials();
      if (!creds) {
        results.push({ user: mask(userId), skipped: 'decrypt_failed' });
        continue;
      }

      const credentialBody = {
        apiKey: creds.token,
        accountId: creds.accountId,
        baseUrl: resolved.baseUrl,
        environment: resolved.activeEnvironment,
      };

      const reassess = await callInternalEndpoint(
        '/api/internal/oanda/active-trades/reassess',
        credentialBody,
      );

      if (!reassess.ok) {
        failed += 1;
        results.push({ user: mask(userId), error: reassess.error || 'reassessment_failed' });
        continue;
      }

      const assessment = (reassess.data ?? {}) as ReassessResponse;
      const plans = Array.isArray(assessment.trades) ? assessment.trades : [];
      tradesReviewed += plans.length;
      usersManaged += 1;

      const userCloses: Record<string, unknown>[] = [];
      const alreadyClosed = new Set(
        (assessment.meta?.autoCloseResults ?? [])
          .filter((item) => item?.ok === true && item.tradeId)
          .map((item) => String(item.tradeId)),
      );

      for (const existing of assessment.meta?.autoCloseResults ?? []) {
        if (existing?.ok !== true) continue;
        closeAttempts += 1;
        closed += 1;
        userCloses.push({
          tradeId: existing.tradeId,
          instrument: existing.instrument,
          ok: true,
          source: 'reassessor_auto_close',
          message: existing.message ?? null,
        });
      }

      for (const plan of plans) {
        if (!plan || plan.error || !plan.tradeId || alreadyClosed.has(String(plan.tradeId))) continue;

        const decision = decideAutoAiClose(plan, now);
        if (!decision.close) continue;

        closeAttempts += 1;
        console.warn(
          `[AUTO_AI_ACTIVE_TRADE_CLOSE] user=${mask(userId)} account=${mask(creds.accountId)} ` +
          `tradeId=${plan.tradeId} pair=${plan.instrument || '?'} category=${decision.category} ` +
          `severity=${decision.severity} reason="${decision.reason}"`,
        );

        const closeResult = await callInternalEndpoint('/api/internal/oanda/close', {
          ...credentialBody,
          tradeId: String(plan.tradeId),
          instrument: plan.instrument,
          units: 'ALL',
        });

        if (closeResult.ok) closed += 1;
        else failed += 1;

        userCloses.push({
          tradeId: String(plan.tradeId),
          instrument: plan.instrument ?? null,
          ok: closeResult.ok,
          error: closeResult.ok ? null : closeResult.error,
          decision,
          source: 'auto_ai_active_trade_management',
        });
      }

      if (userCloses.some((item) => item.ok === true)) {
        const sync = await syncOandaTransactionsForUser({
          userId,
          brokerAccountId: creds.accountId,
          environment: resolved.activeEnvironment as 'practice' | 'live' | 'paper',
          baseUrl: resolved.baseUrl,
          token: creds.token,
        });
        transactionEventsLogged += sync.logged;
      }

      results.push({
        user: mask(userId),
        account: mask(creds.accountId),
        reviewed: plans.length,
        closes: userCloses,
      });
    } catch (err) {
      failed += 1;
      results.push({
        user: mask(userId),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    window: '02:15–17:05 America/New_York',
    entryCutoff: '14:00 America/New_York',
    volatilityCloseDeadline: '17:00 America/New_York',
    users: rows.length,
    usersManaged,
    tradesReviewed,
    closeAttempts,
    closed,
    failed,
    transactionEventsLogged,
    results,
  });
}
