/**
 * web/app/page.tsx
 *
 * Public landing page — login / signup only.
 *
 * If the request is already authenticated, bounce straight to /dashboard so
 * users don't see the sign-in form when they revisit. The auth() helper is the
 * server-side equivalent of useUser() — no flash of unauthenticated content.
 */

import { redirect } from 'next/navigation';
import { auth } from '@clerk/nextjs/server';
import { SignIn, SignUp } from '@clerk/nextjs';

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string }>;
}) {
  const { userId } = await auth();
  if (userId) redirect('/dashboard');

  const { mode } = await searchParams;
  const showSignUp = mode === 'signup';

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: '48px 16px',
      }}
    >
      <header style={{ textAlign: 'center', maxWidth: 520 }}>
        <h1
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 800,
            fontSize: 36,
            letterSpacing: '-0.5px',
            margin: 0,
          }}
        >
          Signal Stack
        </h1>
        <p style={{ color: 'var(--muted)', marginTop: 8, fontSize: 14 }}>
          Multi-broker trading signals. Connect your own OANDA or Alpaca account &mdash;
          your credentials never leave the server.
        </p>
      </header>

      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: 4,
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 8,
        }}
      >
        <a
          href="/"
          style={{
            padding: '8px 20px',
            borderRadius: 6,
            background: showSignUp ? 'transparent' : 'var(--border)',
            color: showSignUp ? 'var(--muted)' : 'var(--text)',
            fontWeight: 700,
            textDecoration: 'none',
            fontSize: 13,
          }}
        >
          Sign in
        </a>
        <a
          href="/?mode=signup"
          style={{
            padding: '8px 20px',
            borderRadius: 6,
            background: showSignUp ? 'var(--border)' : 'transparent',
            color: showSignUp ? 'var(--text)' : 'var(--muted)',
            fontWeight: 700,
            textDecoration: 'none',
            fontSize: 13,
          }}
        >
          Create account
        </a>
      </div>

      <div style={{ width: '100%', maxWidth: 440, display: 'flex', justifyContent: 'center' }}>
        {showSignUp ? (
          <SignUp routing="hash" forceRedirectUrl="/dashboard" />
        ) : (
          <SignIn routing="hash" forceRedirectUrl="/dashboard" />
        )}
      </div>
    </main>
  );
}
