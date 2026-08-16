import 'server-only';

type JsonRecord = Record<string, unknown>;

export type PairPlaybookNarrative = {
  used: boolean;
  model: string | null;
  trendThesis: string;
  bestEntryContext: string;
  valuableSignals: string[];
  avoidSignals: string[];
  evidenceWarning: string;
  rawReason?: string;
};

function deterministicNarrative(profile: JsonRecord, reason: string): PairPlaybookNarrative {
  const windows = Array.isArray(profile.preferredWindows) ? profile.preferredWindows as JsonRecord[] : [];
  const valuable = Array.isArray(profile.valuableConfirmations) ? profile.valuableConfirmations as JsonRecord[] : [];
  const weak = Array.isArray(profile.weakConfirmations) ? profile.weakConfirmations as JsonRecord[] : [];
  const firstWindow = windows[0];
  const sampleSize = Number(profile.sampleSize ?? 0);
  const stage = String(profile.stage ?? 'display_only');
  return {
    used: false,
    model: null,
    trendThesis: sampleSize > 0
      ? `The pair profile is based on ${sampleSize} graded 60-minute outcomes and remains in ${stage} mode.`
      : 'No graded outcomes are available yet.',
    bestEntryContext: firstWindow
      ? `${String(firstWindow.session ?? 'session')} near ${String(firstWindow.timeBucketEt ?? 'unknown time')} ET with ${String(firstWindow.direction ?? 'either direction')} evidence.`
      : 'No scalp window has enough positive evidence yet.',
    valuableSignals: valuable.slice(0, 5).map((item) => String(item.confirmation ?? '')).filter(Boolean),
    avoidSignals: weak.slice(0, 5).map((item) => String(item.confirmation ?? '')).filter(Boolean),
    evidenceWarning: profile.autoTradePriorityEligible === true
      ? 'Eligible for account-scoped priority inside a matching proven ET window; confidence, R:R, risk, and all native execution gates remain unchanged.'
      : stage === 'calibration_ready'
      ? 'Evidence is sufficient for bounded validation but does not meet the auto-trade priority policy.'
      : 'Evidence is preliminary. Do not change live thresholds from this narrative.',
    rawReason: reason,
  };
}

function extractText(payload: JsonRecord): string {
  const content = Array.isArray(payload.content) ? payload.content as JsonRecord[] : [];
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => String(block.text))
    .join('\n')
    .trim();
}

function parseJson(text: string): JsonRecord | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || text.match(/\{[\s\S]*\}/)?.[0];
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    return null;
  }
}

function shortText(value: unknown, fallback: string, max = 500): string {
  const text = String(value ?? '').trim();
  return (text || fallback).slice(0, max);
}

function stringList(value: unknown, max = 8): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, max)
    : [];
}

export async function requestPairPlaybookNarrative(profile: JsonRecord): Promise<PairPlaybookNarrative> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const enabled = String(process.env.EDGE_CLAUDE_ADVISOR_ENABLED || 'true').toLowerCase() === 'true';
  if (!apiKey || !enabled) return deterministicNarrative(profile, 'advisor_disabled_or_missing_api_key');

  const model = String(
    process.env.EDGE_CLAUDE_ADVISOR_MODEL ||
    process.env.ANTHROPIC_MODEL ||
    process.env.CLAUDE_MODEL ||
    'claude-sonnet-4-20250514'
  );
  const timeoutMs = Math.max(1000, Number(process.env.EDGE_CLAUDE_ADVISOR_TIMEOUT_MS || 6000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 700,
        temperature: 0,
        system:
          'You are Signal Stack\'s bounded market-learning advisor. Explain only the deterministic statistics supplied. ' +
          'Do not invent trades, sample sizes, prices, win rates, confirmations, or market facts. Do not recommend bypassing ' +
          'risk, minimum R:R, spread, news, margin, broker, duplicate, or account-drawdown controls. Do not activate a playbook ' +
          'or change numerical thresholds. Return strict JSON only.',
        messages: [{
          role: 'user',
          content:
            'Study this account-scoped pair profile and return ' +
            '{"trendThesis":string,"bestEntryContext":string,"valuableSignals":string[],"avoidSignals":string[],"evidenceWarning":string}. ' +
            `Profile: ${JSON.stringify(profile)}`,
        }],
      }),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return deterministicNarrative(profile, `advisor_http_${response.status}:${detail}`);
    }

    const payload = await response.json() as JsonRecord;
    const parsed = parseJson(extractText(payload));
    if (!parsed) return deterministicNarrative(profile, 'advisor_invalid_json');

    return {
      used: true,
      model,
      trendThesis: shortText(parsed.trendThesis, 'No trend thesis returned.'),
      bestEntryContext: shortText(parsed.bestEntryContext, 'No entry context returned.'),
      valuableSignals: stringList(parsed.valuableSignals),
      avoidSignals: stringList(parsed.avoidSignals),
      evidenceWarning: shortText(parsed.evidenceWarning, 'This playbook remains shadow-only.'),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return deterministicNarrative(profile, `advisor_error:${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
