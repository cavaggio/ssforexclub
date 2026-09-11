# Data API failures and authenticated routes

The Supabase alert reports server errors on all 13 sampled requests across two
consecutive five-minute windows. This is a runtime availability alert, not a
source-code lint or evidence that sign-in is missing. The originating database
error must still be identified from the failing request's status/error code and
the corresponding Supabase request/Postgres logs.

## Database fix

`ops/supabase-executed-learning-index.sql` adds a partial index for executed
observations, matching the existing learning views' filters. It is an online
maintenance statement (`CREATE INDEX CONCURRENTLY`), so execute it outside a
transaction rather than inside a transactional migration runner. It changes
neither the view definitions nor their results and does not change grants/RLS.

The index was applied and verified on the connected project on 2026-09-11. A
representative account/pair context query returned three result rows in both
plans. Before the index it scanned roughly 3,300 observations to find five
executed entries; afterward it used the partial index to fetch those five.
Observed execution time fell from 8.660 ms to 0.779 ms, and observation-table
buffer hits fell from 2,399 to seven. This is a single-query measurement, not a
guarantee about overall latency or proof that the runtime alert has cleared.

## Application mitigations

- The dashboard previously upserted its Clerk shadow profile on every visit.
  Successful profile writes are now reused for five minutes per user/email and
  process; concurrent visits share a write. A changed email writes immediately.
  Failures stay failures, with a 30-second backoff before another attempt. The
  cache holds at most 1,000 completed entries and never holds access decisions,
  credentials, or trading settings. A cold instance writes again.
- Optional profile writes and each complete background learning-profile load
  have a ten-second budget. A failed view cancels its sibling requests. This
  bounds the client's wait; it does not guarantee that an
  already-running database statement is cancelled server-side.
- Background learning reads use `.retry(false)`. SDK versions pinned in this
  repository automatically retry GET requests on some network/503/520 failures,
  multiplying traffic during outages. Their `createClient` implementation does
  not forward `db.retry`, so that configuration alone would not fix this.
- Overlapping loads for the same user/account/engine/pair share one query group.
  The existing successful learning-cache lifetime and error fallback remain.
  Failed loads are released so the next scan can try again. The helper does not
  modify trading rules, risk limits, order submission, or broker management.

These application changes and the database index do not prove the cause of the
original 13 failures. SQL and a minimal Data API probe resumed succeeding during
the investigation, before the index was added. Historical query statistics
identified the learning views as the largest cumulative database costs, but
cannot establish the cause of the original alert without its request logs.

## Existing identity and access model

The Next.js app uses Clerk authentication. Supabase stores application data
keyed by the Clerk user ID. This change retains that identity model; it does not
migrate existing accounts to native Supabase Auth.

`web/proxy.ts` requires a session for routes outside its explicit public list.
The dashboard layout also verifies the session before profile synchronization.
Only the six existing cron endpoints bypass Clerk, and every one verifies
`AUTO_AI_CRON_SECRET`. Newly added cron routes now require authentication unless
explicitly reviewed and added. The server-only database client retains its
service-role key, so server queries must remain scoped to verified user IDs;
client-facing access must retain appropriate RLS policies.

## Verification and deployment

From `web`, run `npm run test:supabase-reliability` and
`./node_modules/.bin/tsc --noEmit --incremental false`. The tests exercise real
SDK query behavior with an in-memory HTTP transport, the actual engine loader,
profile synchronization across users/failures, and the real route matcher.
They do not place trades or require production credentials.

Deploy the web changes through Vercel and the server changes through Railway.
The index is already applied to the connected project; use the operations SQL
for other environments. No Auth migration is included. After deployment:

1. Confirm a minimal database query and an authorized, small Data API read succeed.
2. Test unauthenticated dashboard/API rejection and authenticated account access.
3. Inspect Supabase request logs for the original failed endpoint and error code.
4. Confirm server errors remain below the alert threshold in two subsequent
   five-minute windows before marking the alert resolved.

If even a minimal database query continues to time out, investigate Supabase
database/service availability separately; adding Auth or suppressing an alert
will not restore it.

References: [Supabase retry guidance](https://supabase.com/docs/guides/api/automatic-retries-in-supabase-js),
[query abort signals](https://supabase.com/docs/reference/javascript/using-modifiers-abortsignal),
[Data API error codes](https://supabase.com/docs/guides/api/rest/postgrest-error-codes),
[Clerk integration](https://supabase.com/docs/guides/auth/third-party/clerk).
