/**
 * web/lib/users.ts
 *
 * Shadow-user upsert. Clerk owns identity; our `users` table just exists so
 * other app tables (broker_connections, signals, trades, …) can keep a stable
 * foreign-key target inside our Postgres instance.
 *
 * Called on every authenticated request through the dashboard layout. Idempotent.
 */

import 'server-only';
import { getServerSupabase } from './db';

export type AppUser = {
  clerkUserId: string;
  email: string;
};

export async function upsertUserFromClerk(user: AppUser): Promise<void> {
  if (!user.clerkUserId) throw new Error('upsertUserFromClerk: missing clerkUserId');
  const supabase = getServerSupabase();
  const { error } = await supabase
    .from('users')
    .upsert(
      {
        clerk_user_id: user.clerkUserId,
        email: user.email,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'clerk_user_id' }
    );
  if (error) {
    throw new Error(`users upsert failed: ${error.message}`);
  }
}
