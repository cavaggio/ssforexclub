import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { getServerSupabase } from '@/lib/db';
import { getUserTradingSettings, setActiveBroker } from '@/lib/userTradingSettings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) {
    return NextResponse.json({ ok: false, error: 'Unauthenticated' }, { status: 401 });
  }

  const { id } = await ctx.params;
  const connectionId = String(id || '').trim();
  if (!connectionId) {
    return NextResponse.json({ ok: false, error: 'Connection ID is required' }, { status: 400 });
  }

  try {
    const settings = await getUserTradingSettings(userId);
    if (settings.activeBrokerConnectionId === connectionId && settings.activeBroker) {
      await setActiveBroker({
        clerkUserId: userId,
        activeBroker: settings.activeBroker,
        activeEnvironment: 'practice',
        activeBrokerConnectionId: null,
      });
    }

    const supabase = getServerSupabase();
    const { data, error } = await supabase
      .from('broker_connections')
      .delete()
      .eq('user_id', userId)
      .eq('id', connectionId)
      .select('id');

    if (error) throw new Error(error.message);
    if (!Array.isArray(data) || data.length !== 1) {
      return NextResponse.json(
        { ok: false, error: 'Broker connection was not found or could not be removed' },
        { status: 404 },
      );
    }

    revalidatePath('/dashboard/settings');
    revalidatePath('/dashboard');
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
