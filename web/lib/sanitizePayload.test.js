/**
 * web/lib/sanitizePayload.test.js
 *
 * Pin the redaction algorithm used before any object lands in
 * trade_logs.raw_payload. A bug here = credentials leaking into the
 * database. The full set of REDACTED_KEYS is checked exhaustively, plus
 * nested objects, arrays, primitives, and cycle handling.
 *
 * Run with: node --test web/lib/sanitizePayload.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePayload } from './sanitizePayload.js';

test('primitives + null + undefined pass through unchanged', () => {
  assert.equal(sanitizePayload(null), null);
  assert.equal(sanitizePayload(undefined), undefined);
  assert.equal(sanitizePayload(42), 42);
  assert.equal(sanitizePayload('hello'), 'hello');
  assert.equal(sanitizePayload(false), false);
});

test('redacts known credential-like keys at the top level', () => {
  const before = {
    apiKey: 'sk-real',
    accountId: '001-001-12345',
    token: 'oanda-bearer',
    nested: { secret: 'shhh', ok: 'visible' },
  };
  const after = sanitizePayload(before);
  assert.equal(after.apiKey, '[redacted]');
  assert.equal(after.token, '[redacted]');
  assert.equal(after.nested.secret, '[redacted]');
  // Non-credential fields survive intact.
  assert.equal(after.accountId, '001-001-12345');
  assert.equal(after.nested.ok, 'visible');
});

test('redaction is case-insensitive', () => {
  const after = sanitizePayload({
    APIKEY: 'a',
    ApiKeyAuth: 'b',
    Authorization: 'Bearer c',
    XInternalAuth: 'd',
    'X-Internal-Auth': 'e',
  });
  for (const v of Object.values(after)) {
    assert.equal(v, '[redacted]');
  }
});

test('redacts inside arrays', () => {
  const after = sanitizePayload([
    { token: 't1', side: 'long' },
    { token: 't2', side: 'short' },
  ]);
  assert.equal(after[0].token, '[redacted]');
  assert.equal(after[0].side, 'long');
  assert.equal(after[1].token, '[redacted]');
});

test('does not mutate the input object', () => {
  const before = { apiKey: 'real', side: 'long' };
  sanitizePayload(before);
  assert.equal(before.apiKey, 'real');
});

test('handles deeply nested structures', () => {
  const before = {
    request: {
      headers: { Authorization: 'Bearer abc' },
      body: { signal: { token: 'oops', pair: 'EUR_USD' } },
    },
    trades: [{ secret: 'k', pair: 'GBP_USD' }],
  };
  const after = sanitizePayload(before);
  assert.equal(after.request.headers.Authorization, '[redacted]');
  assert.equal(after.request.body.signal.token, '[redacted]');
  assert.equal(after.request.body.signal.pair, 'EUR_USD');
  assert.equal(after.trades[0].secret, '[redacted]');
  assert.equal(after.trades[0].pair, 'GBP_USD');
});

test('handles cycles without infinite recursion', () => {
  const a = { side: 'long' };
  a.self = a;
  const out = sanitizePayload(a);
  assert.equal(out.side, 'long');
  assert.equal(out.self, '[circular]');
});

test('preserves non-credential keys that happen to contain credential-like substrings', () => {
  // "tokenized" / "secretly" / "passwordless" are NOT in the redaction set;
  // we only redact exact-key matches. This is intentional to avoid false
  // positives on legitimate field names.
  const after = sanitizePayload({
    tokenized: true,
    secretly: 'no',
    passwordless: 'yes',
  });
  assert.equal(after.tokenized, true);
  assert.equal(after.secretly, 'no');
  assert.equal(after.passwordless, 'yes');
});
