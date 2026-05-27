# Signal Stack — Web (Next.js 16)

The user-facing multi-tenant front-end. Pairs with the existing Express
scanner in `../server/` (which keeps running unchanged — it's the backend
service this app calls).

## Stack

- Next.js 16 App Router (React 19)
- Clerk authentication
- Supabase Postgres (managed Postgres only — auth is Clerk, not Supabase Auth)
- AES-256-GCM encryption for per-user broker credentials

## Routes

| Path        | Auth        | Notes                                        |
| ----------- | ----------- | -------------------------------------------- |
| `/`         | Public      | Login / signup tabs (Clerk components)       |
| `/dashboard`| Protected   | Authenticated user landing — scaffold only   |
| `/api/health` | Public    | Health probe — no DB access                  |

Anything not listed above is protected by `middleware.ts` and bounces
unauthenticated requests back to `/`.

## Local setup

```bash
cd web
cp .env.example .env.local      # fill in keys
npm install
npm run dev                     # http://localhost:3000
```

In a separate terminal, run the existing scanner from the repo root:

```bash
npm run dev:server              # http://localhost:3001
```

## Generating ENCRYPTION_KEY

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put the output in `.env.local` as `ENCRYPTION_KEY=<the 64-hex string>`.
Rotating the key requires re-encrypting every row in `broker_connections`
with the new key — there is no automatic migration.

## Database

Apply the multi-tenant schema with the migration in
`../supabase/migrations/20260527000000_clerk_multi_tenant_init.sql`.

```bash
supabase db push    # or run the SQL through the Supabase SQL editor
```

The migration creates:

- `public.users` — shadow user table keyed by Clerk's `user_id`
- `public.broker_connections` — encrypted per-user broker credentials with
  unique `(user_id, broker, account_id, environment)` constraint
- RLS enabled with deny-all policies (the app uses the service role)

## Security model

- **Identity**: Clerk owns authentication. We never roll our own.
- **User scoping**: Every server-side query derives `user_id` from
  `auth().userId` — never from a request body or URL. Search the codebase
  for `clerkUserId` to audit.
- **Credentials**: Broker tokens are AES-256-GCM encrypted before insert,
  stored as `iv:tag:ciphertext` hex strings. Decryption only happens
  server-side in `lib/brokerConnections.ts::getDecryptedBrokerCredentials`.
- **No client secrets**: `SUPABASE_SERVICE_ROLE_KEY`, `CLERK_SECRET_KEY`,
  and `ENCRYPTION_KEY` are server-only. `lib/db.ts` and `lib/encryption.ts`
  carry `import 'server-only'` so Next.js will refuse to bundle them into
  any client component.

## What ships next

- Connect-broker wizard at `/dashboard/connect`
- Authenticated proxy routes at `/api/scanner/*` that decrypt the user's
  broker credentials server-side and call the Express scanner with them
- Port `ForexSignalStackTab` from the Vite app into `/dashboard`
