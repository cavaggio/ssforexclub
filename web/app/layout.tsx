/**
 * web/app/layout.tsx
 *
 * Root layout. Wraps every page in <ClerkProvider/> so Clerk hooks work
 * everywhere. Server-side auth lookups (`auth()`) work independently of this
 * provider — the provider is for the client-side `<UserButton/>` etc.
 *
 * `signInUrl="/"` and `signInFallbackRedirectUrl="/dashboard"` are the two
 * routing hooks: unauthenticated requests bounce to `/`, post-sign-in goes to
 * the dashboard. Same pattern for sign-up.
 */

import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata: Metadata = {
  title: 'Signal Stack',
  description: 'Multi-broker trading signal dashboard.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider
      signInUrl="/"
      signUpUrl="/"
      signInFallbackRedirectUrl="/dashboard"
      signUpFallbackRedirectUrl="/dashboard"
    >
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
