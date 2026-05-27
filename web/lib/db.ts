/**
 * web/lib/db.ts
 *
 * Server-only Supabase Postgres client.
 *
 *   - Uses the SERVICE_ROLE key so it can bypass RLS and write to any row.
 *   - The service-role key MUST NEVER ship to the browser. We mark the
 *     module with `import 'server-only'` so Next.js' bundler refuses to
 *     include it in any client bundle.
 *   - Every consumer of this client MUST filter queries by the
 *     authenticated Clerk user_id. Never accept user_id from the request
 *     body or URL params — derive it from `auth()` server-side.
 */

import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See web/.env.example.'
    );
  }
  _client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return _client;
}
