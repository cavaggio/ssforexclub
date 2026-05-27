/**
 * web/components/sign-out-button.tsx
 *
 * Tiny client component — wraps Clerk's <SignOutButton/> to attach our
 * own styling and a consistent redirect target.
 */

'use client';

import { SignOutButton as ClerkSignOutButton } from '@clerk/nextjs';

export function SignOutButton() {
  return (
    <ClerkSignOutButton redirectUrl="/">
      <button
        type="button"
        style={{
          background: 'transparent',
          color: 'var(--muted)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '6px 14px',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Sign out
      </button>
    </ClerkSignOutButton>
  );
}
