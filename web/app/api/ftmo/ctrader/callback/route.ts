import { auth } from '@clerk/nextjs/server';
import { revalidatePath } from 'next/cache';
import { NextRequest, NextResponse } from 'next/server';
import { saveFuturesConnection } from '@/lib/futuresProvider';
import {
  discoverCTraderAccounts,
  exchangeCTraderAuthorizationCode,
  getCTraderAppCredentials,
  resolveCTraderRedirectUri,
} from '@/lib/ctraderOpenApi';
import type { BrokerEnvironment } from '@/lib/brokerConnections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const OAUTH_COOKIE = 'signal_stack_ctrader_oauth';
const VALID_PHASES = new Set(['challenge', 'verification', 'funded']);

type OAuthCookie = {
  state: string;
  userId: string;
  environment: BrokerEnvironment;
  createdAt: number;
};

function redirectToFtmo(request: NextRequest, params: Record<string, string>): NextResponse {
  const target = new URL('/dashboard/ftmo', request.url);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  const response = NextResponse.redirect(target);
  response.cookies.delete(OAUTH_COOKIE);
  return response;
}

function parseOAuthCookie(value: string | undefined): OAuthCookie | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as OAuthCookie;
    if (!parsed?.state || !parsed?.userId || !parsed?.createdAt) return null;
    if (!VALID_PHASES.has(String(parsed.environment))) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const { userId } = await auth();

  if (!userId) {
    return redirectToFtmo(request, {
      ctrader: 'error',
      message: 'Sign in again before completing the cTrader connection.',
    });
  }

  try {
    const code = String(request.nextUrl.searchParams.get('code') || '').trim();
    const returnedState = String(request.nextUrl.searchParams.get('state') || '').trim();
    const oauth = parseOAuthCookie(request.cookies.get(OAUTH_COOKIE)?.value);

    if (!code) throw new Error('cTrader did not return an authorization code');
    if (!oauth) throw new Error('The cTrader authorization session expired. Start the connection again.');
    if (oauth.userId !== userId) throw new Error('The cTrader authorization user does not match the signed-in user');
    if (Date.now() - oauth.createdAt > 10 * 60 * 1000) throw new Error('The cTrader authorization session expired');
    if (returnedState && returnedState !== oauth.state) throw new Error('Invalid cTrader OAuth state');

    const { clientId, clientSecret } = getCTraderAppCredentials();
    const redirectUri = resolveCTraderRedirectUri(request.url);
    const tokenSet = await exchangeCTraderAuthorizationCode({
      code,
      redirectUri,
      clientId,
      clientSecret,
    });

    const grantedAccounts = await discoverCTraderAccounts({
      accessToken: tokenSet.accessToken,
      clientId,
      clientSecret,
    });

    const ftmoAccounts = grantedAccounts.filter((account) =>
      !account.brokerTitleShort || /ftmo/i.test(account.brokerTitleShort),
    );

    if (ftmoAccounts.length === 0) {
      throw new Error('No FTMO cTrader account was authorized. Select the FTMO account when cTrader asks for access.');
    }

    const expiresAt = new Date(Date.now() + tokenSet.expiresIn * 1000).toISOString();

    for (const account of ftmoAccounts) {
      await saveFuturesConnection({
        clerkUserId: userId,
        provider: 'ftmo',
        environment: oauth.environment,
        credentials: {
          platform: 'ctrader',
          connector: 'ctrader-open-api',
          accountId: account.ctidTraderAccountId,
          traderLogin: account.traderLogin,
          isLive: account.isLive,
          brokerTitleShort: account.brokerTitleShort,
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          tokenType: tokenSet.tokenType,
          expiresAt,
        },
      });
    }

    revalidatePath('/dashboard/ftmo');

    return redirectToFtmo(request, {
      ctrader: 'connected',
      accounts: String(ftmoAccounts.length),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return redirectToFtmo(request, {
      ctrader: 'error',
      message: message.slice(0, 300),
    });
  }
}
