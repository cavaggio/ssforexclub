/**
 * web/lib/users.ts
 *
 * Shadow-user upsert. Clerk owns identity; our `users` table just exists so
 * other app tables (broker_connections, signals, trades, …) can keep a stable
 * foreign-key target inside our Postgres instance.
 *
 * Called by the protected dashboard layout. Successful writes are reused for
 * five minutes per user/email; overlapping writes share one request. Failed
 * writes back off for 30 seconds. This cache is never used for authorization.
 */

import 'server-only';
import { getServerSupabase } from './db';
import { createUserProfileSync } from './userProfileSync';

export type AppUser = {
  clerkUserId: string;
  email: string;
};

const syncUserProfile = createUserProfileSync(async (user: AppUser): Promise<void> => {
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
    )
    .retry(false)
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) {
    throw new Error(`users upsert failed [${error.code || 'unknown'}]: ${error.message}`);
  }
});

export async function upsertUserFromClerk(user: AppUser): Promise<void> {
  return syncUserProfile(user);
}
