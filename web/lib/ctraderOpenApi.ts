import 'server-only';

export type CTraderTokenSet = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
};

export type CTraderGrantedAccount = {
  ctidTraderAccountId: string;
  traderLogin: string | null;
  isLive: boolean;
  brokerTitleShort: string | null;
};

type CTraderMessage = {
  clientMsgId?: string;
  payloadType?: number;
  payload?: Record<string, unknown>;
};

const APPLICATION_AUTH_REQ = 2100;
const APPLICATION_AUTH_RES = 2101;
const GET_ACCOUNTS_REQ = 2149;
const GET_ACCOUNTS_RES = 2150;
const ERROR_RES = 2142;

function requiredEnv(name: 'CTRADER_OPEN_API_CLIENT_ID' | 'CTRADER_OPEN_API_CLIENT_SECRET'): string {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

export function getCTraderAppCredentials(): { clientId: string; clientSecret: string } {
  return {
    clientId: requiredEnv('CTRADER_OPEN_API_CLIENT_ID'),
    clientSecret: requiredEnv('CTRADER_OPEN_API_CLIENT_SECRET'),
  };
}

export function resolveCTraderRedirectUri(requestUrl: string): string {
  const configured = String(process.env.CTRADER_OPEN_API_REDIRECT_URI || '').trim();
  if (configured) return configured;
  return new URL('/api/ftmo/ctrader/callback', requestUrl).toString();
}

export function buildCTraderAuthorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL('https://id.ctrader.com/my/settings/openapi/grantingaccess/');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('scope', 'trading');
  url.searchParams.set('product', 'web');
  url.searchParams.set('state', args.state);
  return url.toString();
}

export async function exchangeCTraderAuthorizationCode(args: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<CTraderTokenSet> {
  const url = new URL('https://openapi.ctrader.com/apps/token');
  url.searchParams.set('grant_type', 'authorization_code');
  url.searchParams.set('code', args.code);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('client_secret', args.clientSecret);

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const accessToken = String(body?.accessToken || '').trim();
  const refreshToken = String(body?.refreshToken || '').trim();

  if (!response.ok || !accessToken || !refreshToken || body?.errorCode) {
    const description = String(body?.description || body?.errorCode || `HTTP ${response.status}`);
    throw new Error(`cTrader token exchange failed: ${description}`);
  }

  return {
    accessToken,
    refreshToken,
    tokenType: String(body?.tokenType || 'bearer'),
    expiresIn: Number(body?.expiresIn || 2_628_000),
  };
}

async function messageDataToString(data: unknown): Promise<string> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  return String(data ?? '');
}

function normalizeAccount(value: unknown): CTraderGrantedAccount | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const accountId = String(row.ctidTraderAccountId || '').trim();
  if (!accountId) return null;

  return {
    ctidTraderAccountId: accountId,
    traderLogin: row.traderLogin == null ? null : String(row.traderLogin),
    isLive: Boolean(row.isLive),
    brokerTitleShort: row.brokerTitleShort == null ? null : String(row.brokerTitleShort),
  };
}

async function discoverAccountsOnEndpoint(args: {
  endpoint: 'demo' | 'live';
  accessToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<CTraderGrantedAccount[]> {
  const url = `wss://${args.endpoint}.ctraderapi.com:5036`;

  return new Promise<CTraderGrantedAccount[]>((resolve, reject) => {
    const socket = new WebSocket(url);
    let completed = false;

    const finish = (error: Error | null, accounts: CTraderGrantedAccount[] = []) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      try { socket.close(); } catch { /* no-op */ }
      if (error) reject(error);
      else resolve(accounts);
    };

    const timeout = setTimeout(() => {
      finish(new Error(`cTrader ${args.endpoint} account discovery timed out`));
    }, 12_000);

    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        clientMsgId: crypto.randomUUID(),
        payloadType: APPLICATION_AUTH_REQ,
        payload: {
          clientId: args.clientId,
          clientSecret: args.clientSecret,
        },
      }));
    });

    socket.addEventListener('message', async (event) => {
      try {
        const text = await messageDataToString(event.data);
        const message = JSON.parse(text) as CTraderMessage;

        if (message.payloadType === APPLICATION_AUTH_RES) {
          socket.send(JSON.stringify({
            clientMsgId: crypto.randomUUID(),
            payloadType: GET_ACCOUNTS_REQ,
            payload: { accessToken: args.accessToken },
          }));
          return;
        }

        if (message.payloadType === GET_ACCOUNTS_RES) {
          const raw = message.payload?.ctidTraderAccount;
          const accounts = Array.isArray(raw)
            ? raw.map(normalizeAccount).filter((account): account is CTraderGrantedAccount => Boolean(account))
            : [];
          finish(null, accounts);
          return;
        }

        if (message.payloadType === ERROR_RES) {
          const code = String(message.payload?.errorCode || 'UNKNOWN');
          const description = String(message.payload?.description || 'cTrader Open API error');
          finish(new Error(`${args.endpoint} cTrader error ${code}: ${description}`));
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.addEventListener('error', () => {
      finish(new Error(`Unable to connect to cTrader ${args.endpoint} JSON endpoint`));
    });
  });
}

export async function discoverCTraderAccounts(args: {
  accessToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<CTraderGrantedAccount[]> {
  const results = await Promise.allSettled([
    discoverAccountsOnEndpoint({ ...args, endpoint: 'demo' }),
    discoverAccountsOnEndpoint({ ...args, endpoint: 'live' }),
  ]);

  const accounts = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  const unique = new Map<string, CTraderGrantedAccount>();

  for (const account of accounts) unique.set(account.ctidTraderAccountId, account);

  if (unique.size === 0 && results.every((result) => result.status === 'rejected')) {
    const reasons = results
      .map((result) => result.status === 'rejected' ? result.reason : null)
      .filter(Boolean)
      .map(String)
      .join('; ');
    throw new Error(`Unable to discover cTrader accounts: ${reasons}`);
  }

  return [...unique.values()];
}
