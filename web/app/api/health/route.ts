/**
 * web/app/api/health/route.ts
 *
 * Unauthenticated health-check endpoint for Vercel/Render probes and uptime
 * monitors. Does NOT touch the database — keep it cheap and side-effect free.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET() {
  return NextResponse.json({ ok: true, service: 'signal-stack-web', ts: new Date().toISOString() });
}
