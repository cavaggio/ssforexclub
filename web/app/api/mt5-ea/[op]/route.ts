import { NextRequest, NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db';
import { authenticateMt5EaTerminal, markMt5EaHeartbeat } from '@/lib/ftmoEaTerminal';

export const dynamic = 'force-dynamic';

function bearer(req: NextRequest): string {
  const value = req.headers.get('authorization') || '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

async function authTerminal(req: NextRequest, body: Record<string, unknown>) {
  const accountLogin = String(body.accountLogin || '').trim();
  const terminalId = String(body.terminalId || '').trim();
  const token = bearer(req);
  if (!accountLogin || !terminalId || !token) return null;
  const terminal = await authenticateMt5EaTerminal({ accountLogin, terminalId, token });
  return terminal ? { ...terminal, accountLogin, terminalId } : null;
}

async function markSavedFtmoConnectionValidated(userId: string, accountLogin: string) {
  const supabase = getServerSupabase();
  const now = new Date().toISOString();
  await supabase.from('broker_connections').update({
    validation_status: 'validated',
    last_validated_at: now,
    updated_at: now,
  })
    .eq('user_id', userId)
    .eq('broker', 'ftmo')
    .eq('account_id', accountLogin)
    .eq('is_active', true);
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ op: string }> }) {
  const { op } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const terminal = await authTerminal(req, body);
  if (!terminal) return NextResponse.json({ ok: false, error: 'Unauthorized terminal' }, { status: 401 });

  const supabase = getServerSupabase();
  await markMt5EaHeartbeat(
    terminal.terminalId,
    terminal.accountLogin,
    null,
    op === 'heartbeat' ? {
      balance: body.balance,
      equity: body.equity,
      dailyStartingBalance: body.dailyStartingBalance,
      dailyLossPercent: body.dailyLossPercent,
      effectiveRiskPercent: body.effectiveRiskPercent,
      tradingLocked: body.tradingLocked,
      reducedRisk: body.reducedRisk,
      riskPolicyVersion: body.riskPolicyVersion ?? '1.20',
      bridgeVersion: body.bridgeVersion ?? null,
    } : {},
  ).catch(() => undefined);

  if (op === 'heartbeat') {
    const server = String(body.server || '').trim();
    if (server && server !== terminal.server) {
      await markMt5EaHeartbeat(
        terminal.terminalId,
        terminal.accountLogin,
        `Server mismatch: ${server}`,
        {
          balance: body.balance,
          equity: body.equity,
          dailyStartingBalance: body.dailyStartingBalance,
          dailyLossPercent: body.dailyLossPercent,
          effectiveRiskPercent: body.effectiveRiskPercent,
          tradingLocked: body.tradingLocked,
          reducedRisk: body.reducedRisk,
          riskPolicyVersion: body.riskPolicyVersion ?? '1.20',
          bridgeVersion: body.bridgeVersion ?? null,
        },
      ).catch(() => undefined);
      return NextResponse.json({ ok: false, error: 'MT5 server does not match saved Signal Stack connection' }, { status: 409 });
    }
    await markSavedFtmoConnectionValidated(terminal.userId, terminal.accountLogin).catch(() => undefined);
    return NextResponse.json({ ok: true, connected: true, server: terminal.server });
  }

  if (op === 'poll') {
    const now = new Date().toISOString();
    await supabase.from('mt5_ea_commands').update({ status: 'expired' })
      .eq('account_login', terminal.accountLogin)
      .eq('terminal_id', terminal.terminalId)
      .eq('status', 'pending')
      .lt('expires_at', now);

    const { data, error } = await supabase.from('mt5_ea_commands')
      .select('id,command_type,payload,idempotency_key,created_at,expires_at')
      .eq('account_login', terminal.accountLogin)
      .eq('terminal_id', terminal.terminalId)
      .eq('status', 'pending')
      .gte('expires_at', now)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ ok: true, command: null });

    const claimedAt = new Date().toISOString();
    const { data: claimed } = await supabase.from('mt5_ea_commands')
      .update({ status: 'claimed', claimed_at: claimedAt })
      .eq('id', data.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle();
    if (!claimed) return NextResponse.json({ ok: true, command: null });
    return NextResponse.json({ ok: true, command: data });
  }

  if (op === 'report') {
    const commandId = String(body.commandId || '').trim();
    if (!commandId) return NextResponse.json({ ok: false, error: 'commandId required' }, { status: 400 });
    const success = body.success === true;
    const result = body.result && typeof body.result === 'object' ? body.result as Record<string, unknown> : {};
    const errorText = success ? null : String(body.error || 'MT5 command failed').slice(0, 1000);
    const { data, error } = await supabase.from('mt5_ea_commands').update({
      status: success ? 'completed' : 'failed',
      completed_at: new Date().toISOString(),
      result,
      error: errorText,
    }).eq('id', commandId)
      .eq('account_login', terminal.accountLogin)
      .eq('terminal_id', terminal.terminalId)
      .select('id,payload')
      .maybeSingle();
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ ok: false, error: 'Unknown command' }, { status: 404 });

    const payload = data.payload && typeof data.payload === 'object'
      ? data.payload as Record<string, unknown>
      : {};
    const order = Number(result.order);
    const deal = Number(result.deal);
    const positionTicket = Number(result.positionTicket);
    const executionResolved = result.executionResolved === true;
    const successfulOrderTest = success &&
      payload.testMode === true &&
      payload.source === 'signal-stack-ftmo-order-test' &&
      executionResolved &&
      Number.isFinite(order) && order > 0 &&
      Number.isFinite(deal) && deal > 0 &&
      Number.isFinite(positionTicket) && positionTicket > 0;

    if (successfulOrderTest) {
      await supabase.from('mt5_ea_terminals').update({
        order_test_verified_at: new Date().toISOString(),
        order_test_command_id: data.id,
        updated_at: new Date().toISOString(),
      })
        .eq('account_login', terminal.accountLogin)
        .eq('terminal_id', terminal.terminalId);
    }

    return NextResponse.json({
      ok: true,
      orderTestVerified: successfulOrderTest || undefined,
      executionResolved: success ? executionResolved : undefined,
    });
  }

  return NextResponse.json({ ok: false, error: 'Unknown MT5 EA operation' }, { status: 404 });
}
