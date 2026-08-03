import Anthropic from '@anthropic-ai/sdk';

const finite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

let advisorAuthCircuitReason = null;

function extractText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function parseJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

export function configuredIctClaudeModel() {
  return String(
    process.env.ICT_CLAUDE_ADVISOR_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    process.env.CLAUDE_MODEL ||
    'claude-sonnet-4-6'
  );
}

export function isIctClaudeAdvisorEnabled() {
  const enabled = String(process.env.ICT_CLAUDE_ADVISOR_ENABLED || 'true').toLowerCase() === 'true';
  return enabled && Boolean(process.env.ANTHROPIC_API_KEY) && !advisorAuthCircuitReason;
}

export function resetIctClaudeAdvisorAuthCircuitForTests() {
  advisorAuthCircuitReason = null;
}

function isAuthenticationFailure(error) {
  const status = Number(error?.status ?? error?.statusCode);
  const message = String(error?.message || error || '').toLowerCase();
  return status === 401 || message.includes('invalid x-api-key') || message.includes('authentication_error');
}

/**
 * Claude is advisory only. It can recommend a small additional pre-entry stop
 * buffer; deterministic code applies the final limit and position sizing.
 */
export async function requestIctStopAdvice({
  pair,
  direction,
  entry,
  stopLoss,
  targetProfit,
  analysis = {},
} = {}) {
  if (advisorAuthCircuitReason) {
    return { used: false, suggestedExtraPips: 0, reason: advisorAuthCircuitReason };
  }
  if (!isIctClaudeAdvisorEnabled()) {
    return { used: false, suggestedExtraPips: 0, reason: 'advisor_disabled_or_missing_api_key' };
  }

  const timeoutMs = Math.max(500, finite(process.env.ICT_CLAUDE_ADVISOR_TIMEOUT_MS) ?? 2500);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const manipulation = analysis?.riskModel?.manipulation ?? analysis?.manipulation ?? null;
  const payload = {
    pair,
    direction,
    entry,
    stopLoss,
    targetProfit,
    confidence: analysis?.confidence,
    setupType: analysis?.setupType,
    atrPips: analysis?.atrPips,
    riskReward: analysis?.rr,
    manipulation,
    conceptsDetected: Array.isArray(analysis?.conceptsDetected)
      ? analysis.conceptsDetected.slice(0, 20)
      : [],
    timing: analysis?.timing ?? null,
  };

  const request = client.messages.create({
    model: configuredIctClaudeModel(),
    max_tokens: 220,
    temperature: 0,
    system:
      'You are a bounded ICT execution-risk advisor. Review only the supplied, already-qualified trade. ' +
      'A stop must remain beyond true structural invalidation or the liquidity-raid extreme. ' +
      'Never recommend moving a live stop farther away, changing direction, inventing a target, increasing dollar risk, ' +
      'or adding confirmation requirements. You may suggest only a small additional PRE-ENTRY stop buffer for abnormal ' +
      'ATR, repeated rejection wicks, or a confirmed liquidity raid. Return strict JSON only.',
    messages: [{
      role: 'user',
      content:
        `Evaluate this qualified ICT setup and return {"suggestedExtraPips": number, "confidence": number, ` +
        `"reason": string}. Use 0 when no extra buffer is justified. Setup: ${JSON.stringify(payload)}`,
    }],
  });

  let message;
  try {
    message = await Promise.race([
      request,
      new Promise((_, reject) => setTimeout(() => reject(new Error('ICT Claude advisor timeout')), timeoutMs)),
    ]);
  } catch (error) {
    if (isAuthenticationFailure(error)) {
      advisorAuthCircuitReason = 'advisor_auth_circuit_open:invalid_anthropic_api_key';
      console.error('[ICT_CLAUDE_ADVISOR] authentication failed; advisor disabled for this process until credentials are corrected.');
      return { used: false, suggestedExtraPips: 0, reason: advisorAuthCircuitReason };
    }
    console.warn(`[ICT_CLAUDE_ADVISOR] skipped: ${error.message}`);
    return { used: false, suggestedExtraPips: 0, reason: `advisor_error:${error.message}` };
  }

  const parsed = parseJson(extractText(message));
  const suggestion = Math.max(0, finite(parsed?.suggestedExtraPips) ?? 0);
  const confidence = Math.max(0, Math.min(100, finite(parsed?.confidence) ?? 0));
  const reason = String(parsed?.reason || 'No advisor rationale returned.').slice(0, 300);

  return {
    used: true,
    model: configuredIctClaudeModel(),
    suggestedExtraPips: +suggestion.toFixed(1),
    confidence: +confidence.toFixed(1),
    reason,
  };
}
