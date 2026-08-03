import 'server-only';
import { getServerSupabase } from './db';

export type AutoClosePreference = {
  enabled: boolean;
  migrationRequired: boolean;
};

function migrationMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  const message = String(error?.message || '');
  return error?.code === '42703' || /auto_close_enabled|column .* does not exist/i.test(message);
}

export async function getAutoClosePreference(userId: string): Promise<AutoClosePreference> {
  if (!userId) throw new Error('getAutoClosePreference: missing userId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .select('auto_close_enabled')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    if (migrationMissing(error)) return { enabled: false, migrationRequired: true };
    throw new Error(`getAutoClosePreference: ${error.message}`);
  }

  return {
    enabled: Boolean(data?.auto_close_enabled),
    migrationRequired: false,
  };
}

export async function setAutoClosePreference(userId: string, enabled: boolean): Promise<AutoClosePreference> {
  if (!userId) throw new Error('setAutoClosePreference: missing userId');
  const supabase = getServerSupabase();
  const { data, error } = await supabase
    .from('user_trading_settings')
    .upsert({
      user_id: userId,
      auto_close_enabled: Boolean(enabled),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })
    .select('auto_close_enabled')
    .single();

  if (error || !data) {
    if (migrationMissing(error)) {
      throw new Error(
        'Auto Exit Management requires the Supabase migration ' +
        '20260803003000_active_exit_intelligence.sql before it can be enabled.',
      );
    }
    throw new Error(`setAutoClosePreference: ${error?.message ?? 'no row returned'}`);
  }

  return { enabled: Boolean(data.auto_close_enabled), migrationRequired: false };
}
