import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(msg: string, status = 500) {
  return json({ error: msg }, status);
}

// ── Alpaca REST helper ────────────────────────────────────────────────────────

async function alpacaFetch(
  baseUrl: string,
  path: string,
  key: string,
  secret: string,
  options: RequestInit = {},
): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      "Content-Type": "application/json",
      ...(options.headers as Record<string, string> ?? {}),
    },
  });
}

// Throws with Alpaca's error message if not ok, otherwise returns parsed JSON.
async function alpacaJson<T>(
  baseUrl: string,
  path: string,
  key: string,
  secret: string,
  options: RequestInit = {},
): Promise<T> {
  const r = await alpacaFetch(baseUrl, path, key, secret, options);
  if (!r.ok) {
    const body = await r.json().catch(() => ({})) as Record<string, unknown>;
    const msg = (body.message as string) ?? (body.error as string) ?? `HTTP ${r.status}`;
    throw new Error(`Alpaca ${r.status}: ${msg}`);
  }
  return r.json() as Promise<T>;
}

function getCredentials(env: string): { key: string; secret: string; baseUrl: string } | null {
  const isPaper = env !== "live";
  const key    = isPaper ? Deno.env.get("ALPACA_PAPER_API_KEY")    : Deno.env.get("ALPACA_LIVE_API_KEY");
  const secret = isPaper ? Deno.env.get("ALPACA_PAPER_API_SECRET") : Deno.env.get("ALPACA_LIVE_API_SECRET");
  if (!key || !secret) return null;
  return {
    key,
    secret,
    baseUrl: isPaper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets",
  };
}

function formatAccount(a: Record<string, unknown>) {
  return {
    accountNumber:    a.account_number,
    buyingPower:      parseFloat((a.buying_power   as string) || "0"),
    cash:             parseFloat((a.cash           as string) || "0"),
    portfolioValue:   parseFloat((a.portfolio_value as string) || "0"),
    equity:           parseFloat((a.equity         as string) || (a.portfolio_value as string) || "0"),
    dayTradingBuyingPower: parseFloat((a.daytrading_buying_power as string) || (a.buying_power as string) || "0"),
    daytradeCount:    a.daytrade_count,
    status:           a.status,
    tradingBlocked:   a.trading_blocked,
    accountBlocked:   a.account_blocked,
    patternDayTrader: a.pattern_day_trader,
    optionsLevel:     a.options_level ?? null,
  };
}

function isWithinTradingWindow(): boolean {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = et.getDay();
  if (day === 0 || day === 6) return false;
  const total = et.getHours() * 60 + et.getMinutes();
  return total >= (9 * 60 + 35) && total <= (15 * 60 + 55);
}

// ── In-memory risk state (per-isolate, resets on cold start) ─────────────────

const riskState = {
  tradesToday:       0,
  consecutiveLosses: 0,
  dailyPnl:          0,
  tradingDisabled:   false,
  dailyTargetReached:false,
  disableReason:     undefined as string | undefined,
};

// ── Router ────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url  = new URL(req.url);
    // Strip the function prefix: /alpaca-proxy/api/alpaca/live/account -> /api/alpaca/live/account
    const path = url.pathname.replace(/^\/alpaca-proxy/, "");
    const envParam = url.searchParams.get("env") ?? "live";
    const env  = envParam === "paper" ? "paper" : "live";

    // ── Health ──────────────────────────────────────────────────────────────
    if (path === "/api/health" && req.method === "GET") {
      return json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // ── Debug: confirm secrets are loaded (never returns full key values) ───
    if (path === "/api/debug/secrets" && req.method === "GET") {
      const mask = (v: string | undefined) =>
        v ? `${v.slice(0, 4)}…${v.slice(-4)} (len=${v.length})` : "NOT SET";
      return json({
        ALPACA_PAPER_API_KEY:    mask(Deno.env.get("ALPACA_PAPER_API_KEY")),
        ALPACA_PAPER_API_SECRET: mask(Deno.env.get("ALPACA_PAPER_API_SECRET")),
        ALPACA_LIVE_API_KEY:     mask(Deno.env.get("ALPACA_LIVE_API_KEY")),
        ALPACA_LIVE_API_SECRET:  mask(Deno.env.get("ALPACA_LIVE_API_SECRET")),
      });
    }

    // ── Validate credentials ────────────────────────────────────────────────
    if (path === "/api/alpaca/validate" && req.method === "POST") {
      const body = await req.json();
      const { apiKey, apiSecret, environment = "paper" } = body;
      if (!apiKey || !apiSecret) {
        return err("apiKey and apiSecret are required", 400);
      }
      const baseUrl = environment === "live"
        ? "https://api.alpaca.markets"
        : "https://paper-api.alpaca.markets";
      const r = await alpacaFetch(baseUrl, "/v2/account", apiKey, apiSecret);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return err(d.message ?? `Alpaca rejected credentials (HTTP ${r.status})`, 401);
      }
      const acct = await r.json();
      return json({
        success: true,
        accountStatus: acct.status,
        accountNumberMasked: "****" + (acct.account_number ?? "").slice(-4),
      });
    }

    // All live/* routes need credentials
    const creds = getCredentials(env);

    // ── Risk state (no Alpaca call needed) ─────────────────────────────────
    if (path === "/api/alpaca/live/risk-state" && req.method === "GET") {
      return json(riskState);
    }

    // ── Disable trading ─────────────────────────────────────────────────────
    if (path === "/api/alpaca/live/disable" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      riskState.tradingDisabled = true;
      riskState.disableReason   = body.reason ?? "Manual kill switch";
      return json({ disabled: true, reason: riskState.disableReason });
    }

    if (!creds) {
      const envLabel = env === "paper" ? "ALPACA_PAPER_API_KEY / ALPACA_PAPER_API_SECRET" : "ALPACA_LIVE_API_KEY / ALPACA_LIVE_API_SECRET";
      return err(`Alpaca ${env} credentials not configured. Add ${envLabel} as Edge Function secrets.`, 503);
    }

    const { key, secret, baseUrl } = creds;

    // ── Account ─────────────────────────────────────────────────────────────
    if (path === "/api/alpaca/live/account" && req.method === "GET") {
      const acct = await alpacaJson<Record<string, unknown>>(baseUrl, "/v2/account", key, secret);
      return json(formatAccount(acct));
    }

    // ── Account state (richer — includes dayTradingBuyingPower) ─────────────
    if (path === "/api/alpaca/live/account-state" && req.method === "GET") {
      const acct = await alpacaJson<Record<string, unknown>>(baseUrl, "/v2/account", key, secret);
      return json(formatAccount(acct));
    }

    // ── Positions ───────────────────────────────────────────────────────────
    if (path === "/api/alpaca/live/positions" && req.method === "GET") {
      const positions = await alpacaJson<Record<string, unknown>[]>(baseUrl, "/v2/positions", key, secret);
      return json(
        Array.isArray(positions)
          ? positions.map((p) => ({
              symbol:        p.symbol,
              qty:           parseFloat((p.qty as string) || "0"),
              side:          p.side,
              marketValue:   parseFloat((p.market_value as string) || "0"),
              unrealizedPl:  parseFloat((p.unrealized_pl as string) || "0"),
              currentPrice:  parseFloat((p.current_price as string) || "0"),
              avgEntryPrice: parseFloat((p.avg_entry_price as string) || "0"),
            }))
          : [],
      );
    }

    // ── Open orders ─────────────────────────────────────────────────────────
    if (path === "/api/alpaca/live/orders" && req.method === "GET") {
      const orders = await alpacaJson<Record<string, unknown>[]>(baseUrl, "/v2/orders?status=open&limit=50", key, secret);
      return json(
        Array.isArray(orders)
          ? orders.map((o) => ({
              id:          o.id,
              symbol:      o.symbol,
              qty:         o.qty,
              side:        o.side,
              type:        o.type,
              status:      o.status,
              limitPrice:  o.limit_price,
              filledQty:   o.filled_qty,
              submittedAt: o.submitted_at,
              filledAt:    o.filled_at,
            }))
          : [],
      );
    }

    // ── Single order (poll for fill) ────────────────────────────────────────
    if (path.startsWith("/api/alpaca/live/order/") && req.method === "GET") {
      const orderId = path.split("/").pop();
      const o = await alpacaJson<Record<string, unknown>>(baseUrl, `/v2/orders/${orderId}`, key, secret);
      return json({
        id:             o.id,
        status:         o.status,
        filledQty:      o.filled_qty,
        filledAvgPrice: o.filled_avg_price,
        filledAt:       o.filled_at,
      });
    }

    // ── Submit trade ────────────────────────────────────────────────────────
    if (path === "/api/alpaca/live/trade" && req.method === "POST") {
      const body = await req.json();
      const { signal, quantity = 1, shadowMode = true } = body;

      if (!signal?.optionSymbol || !signal?.limitPrice) {
        return err("signal.optionSymbol and signal.limitPrice are required", 400);
      }

      if (shadowMode) {
        riskState.tradesToday++;
        return json({
          action:  "shadow",
          orderId: `SHADOW-${Date.now()}`,
          reason:  "Shadow mode active — no real order placed",
        });
      }

      if (!isWithinTradingWindow()) {
        return err("Outside trading window (9:35–15:55 ET)", 422);
      }

      const orderPayload = {
        symbol:        signal.optionSymbol,
        qty:           String(quantity),
        side:          "buy",
        type:          "limit",
        time_in_force: "day",
        limit_price:   signal.limitPrice.toFixed(2),
      };

      const order = await alpacaJson<Record<string, unknown>>(baseUrl, "/v2/orders", key, secret, {
        method: "POST",
        body:   JSON.stringify(orderPayload),
      });
      riskState.tradesToday++;

      return json({
        action:  "submitted",
        orderId: order.id,
        status:  order.status,
        reason:  "Order submitted to Alpaca",
      });
    }

    // ── Asset universe (active tradable US equities) ────────────────────────
    if (path === "/api/alpaca/assets" && req.method === "GET") {
      // Fetch all active US equity assets from Alpaca
      // We use the broker/data base URL without the /v2/orders pattern — assets is on the trading API
      const assetsUrl = env === "paper" ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
      const r = await alpacaFetch(assetsUrl, "/v2/assets?status=active&asset_class=us_equity", key, secret);
      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as Record<string, unknown>;
        return err(`Alpaca assets failed: ${(d.message as string) ?? `HTTP ${r.status}`}`, r.status);
      }
      const assets = await r.json() as Record<string, unknown>[];
      // Filter to tradable, liquid (has symbol, exchange listed)
      const symbols = Array.isArray(assets)
        ? assets
            .filter((a: Record<string, unknown>) =>
              a.tradable === true &&
              a.status === "active" &&
              typeof a.symbol === "string" &&
              (a.symbol as string).length <= 5 &&
              !/[0-9]/.test((a.symbol as string)) // exclude derivatives/special tickers
            )
            .map((a: Record<string, unknown>) => a.symbol as string)
        : [];
      return json({ symbols, total: symbols.length, source: "alpaca" });
    }

    // ── Cancel stale orders ─────────────────────────────────────────────────
    if (path === "/api/alpaca/live/cancel-stale" && req.method === "POST") {
      const r = await alpacaFetch(baseUrl, "/v2/orders", key, secret, { method: "DELETE" });
      const canceled: string[] = [];
      if (r.ok || r.status === 207) {
        const d = await r.json().catch(() => []);
        if (Array.isArray(d)) d.forEach((o: Record<string, unknown>) => o.id && canceled.push(o.id as string));
      }
      return json({ canceled });
    }

    // ── Cancel specific order ───────────────────────────────────────────────
    if (path === "/api/alpaca/live/cancel-order" && req.method === "POST") {
      const body = await req.json();
      const { orderId } = body;
      if (!orderId) return err("orderId is required", 400);
      const r = await alpacaFetch(baseUrl, `/v2/orders/${orderId}`, key, secret, { method: "DELETE" });
      return json({ canceled: orderId, status: r.status });
    }

    return err("Not found", 404);

  } catch (e) {
    console.error("[alpaca-proxy] Unhandled error:", e);
    return err(e instanceof Error ? e.message : "Internal server error", 500);
  }
});
