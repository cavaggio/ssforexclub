import test from 'node:test';
import assert from 'node:assert/strict';

// This process uses a fake transport only. Never contact Supabase or a broker.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
const requests = [];
let unavailable = false;
globalThis.fetch = async (url, init) => {
  init.signal?.throwIfAborted();
  requests.push(new URL(url));
  return new Response(JSON.stringify(unavailable
    ? { code: 'PGRST002', message: 'Database unavailable' }
    : []), {
    status: unavailable ? 503 : 200,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
  });
};
const { loadEngineTradeProfile } = await import('./engineTradeLearning.js');

test('the engine shares concurrent reads and preserves successful profile caching and force refresh', async () => {
  const input = { client: { userId: 'user_one', accountId: 'account_one' }, engine: 'ict', pair: 'EUR_USD' };
  const [first, second] = await Promise.all([loadEngineTradeProfile(input), loadEngineTradeProfile(input)]);
  assert.ok(first);
  assert.equal(first, second);
  assert.equal(requests.length, 9);
  for (const url of requests) {
    assert.equal(url.searchParams.get('user_id'), 'eq.user_one');
    assert.equal(url.searchParams.get('broker_account_id'), 'eq.account_one');
  }
  assert.equal(await loadEngineTradeProfile(input), first);
  assert.equal(requests.length, 9);
  await loadEngineTradeProfile({ ...input, force: true });
  assert.equal(requests.length, 18);
});

test('an actual engine read returns its existing failure fallback, without retry amplification, then recovers', async () => {
  const input = { client: { userId: 'user_two', accountId: 'account_two' }, engine: 'ict', pair: 'GBP_USD' };
  const start = requests.length;
  unavailable = true;
  const results = await Promise.all([loadEngineTradeProfile(input), loadEngineTradeProfile(input)]);
  assert.deepEqual(results, [null, null]);
  // Let cancelled sibling requests finish. Depending on scheduling, the first
  // failure can cancel some of the six views before their HTTP request starts.
  await new Promise((resolve) => setImmediate(resolve));
  const failedRequests = requests.slice(start);
  assert.ok(failedRequests.length > 0 && failedRequests.length <= 6);
  assert.equal(new Set(failedRequests.map((url) => url.pathname)).size, failedRequests.length);
  unavailable = false;
  const recovered = await loadEngineTradeProfile(input);
  assert.equal(recovered.userId, 'user_two');
  assert.equal(requests.length - start, failedRequests.length + 9);
});
