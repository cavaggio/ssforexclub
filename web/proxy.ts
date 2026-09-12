/**
 * web/proxy.ts  (Next.js 16 renamed `middleware.ts` to `proxy.ts`)
 *
 * Clerk route protection.
 *
 *   - `/`             : public (login / signup)
 *   - everything else : authenticated only
 *
 * When an unauthenticated request hits a protected route, Clerk redirects to
 * `/` (configured via `signInUrl` in app/layout.tsx ClerkProvider).
 *
 * Why a single matcher block (not per-route auth.protect calls) — keeps
 * "what's public" auditable in one place so a new route can't accidentally
 * leak by forgetting to call .protect().
 */

import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/api/health',          // unauthenticated health-check (for Vercel/Render probes)
  '/sso-callback(.*)',    // Clerk OAuth handshake
  // Only these system endpoints bypass Clerk. Each verifies X-Cron-Secret.
  // New routes (including /api/cron-* or /api/cron/new-job) stay protected.
  '/api/cron/edge-learning-refresh',
  '/api/cron/oanda-transaction-sync',
  '/api/cron/auto-ai-trading',
  '/api/cron/active-trade-management',
  '/api/cron/auto-ai-trading-extended',
  '/api/cron/engine-learning-backfill',
]);

export default clerkMiddleware(async (auth, req) => {
  if (isPublicRoute(req)) return;
  // Anything not in `isPublicRoute` requires an authenticated session.
  await auth.protect();
});

export const config = {
  matcher: [
    // Run on all routes except Next internals and static files.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API & TRPC routes.
    '/(api|trpc)(.*)',
  ],
};
