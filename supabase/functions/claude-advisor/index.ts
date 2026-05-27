import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Anthropic from "npm:@anthropic-ai/sdk@0.91.1";

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

let _client: Anthropic | null = null;
function getClient(): Anthropic | null {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return null;
  if (!_client) _client = new Anthropic({ apiKey: key });
  return _client;
}

const SYSTEM_PROMPT = `You are a professional options trading advisor for Signal Stack, an AI-powered trading dashboard.
You evaluate trade signals and provide clear, structured recommendations.

Your response must ALWAYS be valid JSON in this exact format:
{
  "decision": "APPROVE" | "CAUTION" | "REJECT",
  "confidence": <number 0-100>,
  "reasoning": "<one sentence>",
  "keyRisks": ["<risk1>", "<risk2>"],
  "recommendation": "<actionable sentence>"
}

Guidelines:
- APPROVE: Strong signal, favorable conditions, risk/reward justified
- CAUTION: Acceptable signal but notable risks — proceed with reduced size or tighter stop
- REJECT: Signal fails key criteria — do not trade
- Be concise. Never include text outside the JSON block.`;

function buildEvalPrompt(signal: Record<string, unknown>, marketContext: Record<string, unknown>): string {
  return `Evaluate this options trade signal:

SIGNAL:
- Ticker: ${signal.ticker}
- Option: ${signal.optionSymbol}
- Score: ${signal.totalScore}/20
- Confidence: ${signal.confidence}%
- Grade: ${signal.grade}
- Risk/Reward: 1:${signal.riskReward}
- Market Alignment: ${signal.marketAlignment}
- Bias: ${signal.bias}
- Entry: $${signal.limitPrice}
- Stop: $${signal.stopLoss}
- Target: $${signal.target}
- Catalyst: ${signal.catalyst ?? "None specified"}

MARKET CONTEXT:
- SPY Trend: ${marketContext.spyTrend ?? "Unknown"}
- VIX Level: ${marketContext.vixLevel ?? "Unknown"}
- Market Regime: ${marketContext.marketRegime ?? "Unknown"}
- Session: ${marketContext.sessionType ?? "Regular"}

Respond with JSON only.`;
}

function buildRankPrompt(signals: unknown[], marketContext: Record<string, unknown>): string {
  const sigList = signals.map((s: unknown, i: number) => {
    const sig = s as Record<string, unknown>;
    return `${i + 1}. ${sig.ticker} ${sig.optionSymbol} — Score: ${sig.totalScore}/20, Grade: ${sig.grade}, R/R: 1:${sig.riskReward}`;
  }).join("\n");

  return `Rank these ${signals.length} trade signals from best to worst opportunity.

SIGNALS:
${sigList}

MARKET CONTEXT:
- SPY Trend: ${marketContext.spyTrend ?? "Unknown"}
- VIX: ${marketContext.vixLevel ?? "Unknown"}

Respond with JSON only in this format:
{
  "ranked": [
    { "ticker": "<ticker>", "decision": "APPROVE|CAUTION|REJECT", "confidence": <0-100>, "reasoning": "<one sentence>", "keyRisks": [], "recommendation": "<one sentence>" }
  ],
  "summary": "<one sentence summarizing the overall market opportunity>"
}`;
}

function parseClaudeJson(text: string): Record<string, unknown> {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON found in Claude response");
  return JSON.parse(match[0]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url  = new URL(req.url);
    const path = url.pathname.replace(/^\/claude-advisor/, "");

    const anthropic = getClient();
    if (!anthropic) {
      return err("ANTHROPIC_API_KEY not configured as an Edge Function secret", 503);
    }

    // ── POST /api/claude/evaluate ───────────────────────────────────────────
    if (path === "/api/claude/evaluate" && req.method === "POST") {
      const body = await req.json();
      const { signal, marketContext = {} } = body;

      if (!signal) return err("signal is required", 400);

      const message = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 512,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: "user", content: buildEvalPrompt(signal, marketContext) }],
      });

      const text = message.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text: string }) => b.text)
        .join("");

      let evaluation: Record<string, unknown>;
      try {
        evaluation = parseClaudeJson(text);
      } catch {
        evaluation = {
          decision:       "CAUTION",
          confidence:     50,
          reasoning:      "Could not parse Claude response — defaulting to CAUTION",
          keyRisks:       ["Parsing error"],
          recommendation: "Review signal manually before trading",
        };
      }

      return json({ evaluation, rawText: text });
    }

    // ── POST /api/claude/rank ───────────────────────────────────────────────
    if (path === "/api/claude/rank" && req.method === "POST") {
      const body = await req.json();
      const { signals = [], marketContext = {} } = body;

      if (!signals.length) return err("signals array is required and must not be empty", 400);

      const message = await anthropic.messages.create({
        model:      "claude-sonnet-4-5",
        max_tokens: 1024,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: "user", content: buildRankPrompt(signals, marketContext) }],
      });

      const text = message.content
        .filter((b: { type: string }) => b.type === "text")
        .map((b: { type: string; text: string }) => b.text)
        .join("");

      let result: Record<string, unknown>;
      try {
        result = parseClaudeJson(text);
      } catch {
        result = {
          ranked:  signals.map((s: unknown) => ({
            ticker:         (s as Record<string, unknown>).ticker,
            decision:       "CAUTION",
            confidence:     50,
            reasoning:      "Parse error",
            keyRisks:       [],
            recommendation: "Review manually",
          })),
          summary: "Could not parse Claude ranking response",
        };
      }

      return json(result);
    }

    return err("Not found", 404);

  } catch (e) {
    console.error("[claude-advisor] Unhandled error:", e);
    return err(e instanceof Error ? e.message : "Internal server error", 500);
  }
});
