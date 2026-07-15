import { auth } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import {
  buildCTraderAuthorizationUrl,
  getCTraderAppCredentials,
  resolveCTraderRedirectUri,
} from '@/lib/ctraderOpenApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OAUTH_COOKIE = 'signal_stack_ctrader_oauth';
const VALID_PHASES = new Set(['challenge', 'verification', 'funded']);

export async function GET(request: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    const signIn = new URL('/sign-in', request.url);
    signIn.searchParams.set('redirect_url', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(signIn);
  }

  try {
    const environment = String(request.nextUrl.searchParams.get('environment') || 'challenge').toLowerCase();
    if (!VALID_PHASES.has(environment)) {
      throw new Error('Choose a valid FTMO phase before connecting cTrader');
    }

    const { clientId } = getCTraderAppCredentials();
    const redirectUri = resolveCTraderRedirectUri(request.url);
    const state = crypto.randomUUID();
    const cookieValue = Buffer.from(JSON.stringify({
      state,
      userId,
      environment,
      createdAt: Date.now(),
    })).toString('base64url');

    const authorizeUrl = buildCTraderAuthorizationUrl({ clientId, redirectUri, state });
    const response = NextResponse.redirect(authorizeUrl);

    response.cookies.set(OAUTH_COOKIE, cookieValue, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: 10 * 60,
    });

    return response;
  } catch (error) {
    const target = new URL('/dashboard/ftmo', request.url);
    target.searchParams.set('ctrader', 'error');
    target.searchParams.set('message', error instanceof Error ? error.message : String(error));
    return NextResponse.redirect(target);
  }
}
