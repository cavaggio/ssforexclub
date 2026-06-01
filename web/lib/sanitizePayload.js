/**
 * web/lib/sanitizePayload.js
 *
 * Deep-redact JSON-shaped values before persisting to trade_logs.raw_payload.
 * The helper is plain JS so it can be unit-tested with `node --test` without
 * extra TypeScript tooling, and re-exported from web/lib/tradeLogs.ts.
 *
 * Algorithm:
 *   - null/undefined/primitives → pass through
 *   - arrays → recurse element-wise
 *   - objects → keep shape; for each key that matches REDACTED_KEYS
 *     (case-insensitive), replace the value with '[redacted]'; otherwise
 *     recurse
 *   - cycles short-circuited via WeakSet → '[circular]'
 *
 * REDACTED_KEYS targets every credential-like field name we accept across
 * the broker layer. New name? Add it here.
 */

const REDACTED_KEYS = new Set([
  'apikey',
  'apikeyauth',
  'token',
  'secret',
  'encryptedtoken',
  'encryptedsecret',
  'authorization',
  'authorisation',
  'password',
  'x-internal-auth',
  'xinternalauth',
  'bearer',
  'cookie',
  'set-cookie',
]);

export function sanitizePayload(input, seen = new WeakSet()) {
  if (input === null || input === undefined) return input;
  if (typeof input !== 'object') return input;
  if (seen.has(input)) return '[circular]';
  seen.add(input);
  if (Array.isArray(input)) return input.map((v) => sanitizePayload(v, seen));
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const normalized = String(key).toLowerCase();
    if (REDACTED_KEYS.has(normalized)) {
      out[key] = '[redacted]';
      continue;
    }
    out[key] = sanitizePayload(value, seen);
  }
  return out;
}
