/**
 * web/app/dashboard/layout.tsx
 *
 * Protected layout. middleware.ts already enforces auth, but we re-check here
 * with `auth.protect()` as defense-in-depth — if a future config change ever
 * accidentally moves /dashboard into the public matcher, this still keeps the
 * page locked.
 *
 * Also: on first sign-in we upsert a row into our `users` table so app data
 * has a stable foreign-key target. This is the SHADOW USER pattern — Clerk
 * owns identity; our DB just stores app-side data keyed by Clerk's user_id.
 */

import { auth, currentUser } from '@clerk/nextjs/server';
import { upsertUserFromClerk } from '@/lib/users';
import { SignOutButton } from '@/components/sign-out-button';
import { DashboardNav } from '@/components/dashboard-nav';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  await auth.protect();
  const user = await currentUser();

  // Best-effort shadow-user upsert. Never fail the page if Postgres is down —
  // unauth content was already gated, and downstream queries that need the
  // user row will surface their own errors.
  if (user) {
    try {
      await upsertUserFromClerk({
        clerkUserId: user.id,
        email: user.primaryEmailAddress?.emailAddress ?? '',
      });
    } catch (err) {
      console.error('[dashboard] users upsert failed:', err);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '16px 24px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--panel)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
          <a
            href="/dashboard"
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 800,
              fontSize: 18,
              color: 'var(--text)',
              textDecoration: 'none',
              letterSpacing: '-0.3px',
            }}
          >
            Signal Stack
          </a>
          <DashboardNav />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {user?.primaryEmailAddress?.emailAddress ? (
            <span style={{ color: 'var(--muted)', fontSize: 13 }}>
              {user.primaryEmailAddress.emailAddress}
            </span>
          ) : null}
          <SignOutButton />
        </div>
      </header>
      <main style={{ flex: 1, padding: 24 }}>{children}</main>
    </div>
  );
}
