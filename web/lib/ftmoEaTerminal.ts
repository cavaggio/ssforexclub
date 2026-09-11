import 'server-only';
import crypto from 'node:crypto';
import { getServerSupabase } from './db';

function clean(value: unknown): string { return String(value ?? '').trim(); }
function hashToken(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

export function generateMt5EaToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export async function registerMt5EaTerminal(args: {
  userId: string;
  accountLogin: string;
  server: string;
  terminalId: string;
  token: string;
}): Promise<void> {
  const supabase = getServerSupabase();
  const payload = {
    user_id: clean(args.userId),
    account_login: clean(args.accountLogin),
    server: clean(args.server),
    terminal_id: clean(args.terminalId),
    token_hash: hashToken(args.token),
    status: 'pending',
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('mt5_ea_terminals').upsert(payload, {
    onConflict: 'user_id,account_login,terminal_id',
  });
  if (error) throw new Error(`registerMt5EaTerminal: ${error.message}`);
}

export async function authenticateMt5EaTerminal(args: {
  accountLogin: string;
  terminalId: string;
  token: string;
}): Promise<{ id: string; userId: string; server: string } | null> {
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('mt5_ea_terminals')
    .select('id,user_id,server,token_hash,status')
    .eq('account_login', clean(args.accountLogin))
    .eq('terminal_id', clean(args.terminalId))
    .maybeSingle();
  if (error || !data || data.status === 'disabled') return null;
  const expected = Buffer.from(String(data.token_hash), 'hex');
  const actual = Buffer.from(hashToken(clean(args.token)), 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return { id: String(data.id), userId: String(data.user_id), server: String(data.server) };
}

export async function markMt5EaHeartbeat(terminalId: string, accountLogin: string, lastError?: string | null): Promise<void> {
  const supabase = getServerSupabase();
  await supabase.from('mt5_ea_terminals').update({
    status: 'connected',
    last_heartbeat_at: new Date().toISOString(),
    last_error: lastError ?? null,
    updated_at: new Date().toISOString(),
  }).eq('account_login', clean(accountLogin)).eq('terminal_id', clean(terminalId));
}
