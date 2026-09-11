import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { createSingleFlight, learningRead } from '../../server/supabaseLearningRead.js';

function client(fetch) {
  return createClient('https://example.supabase.co', 'test-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch },
  });
}

test('a real SDK learning query sends one request for a 503 and preserves its error', async () => {
  let requests = 0;
  const db = client(async () => {
    requests++;
    return new Response(JSON.stringify({ code: 'PGRST002', message: 'Schema cache unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
    });
  });
  const result = await learningRead(db.from('learning').select('*'));
  assert.equal(requests, 1);
  assert.equal(result.status, 503);
  assert.equal(result.error.code, 'PGRST002');
  assert.equal(result.data, null);
});

test('network failures are returned without replaying the query', async () => {
  let requests = 0;
  const db = client(async () => { requests++; throw new TypeError('fetch failed'); });
  const result = await learningRead(db.from('learning').select('*'));
  assert.equal(requests, 1);
  assert.ok(result.error);
  assert.equal(result.data, null);
});

test('successful reads preserve account filters and the returned learning data', async () => {
  const rows = [{ score: 0.7 }];
  const db = client(async (url) => {
    assert.equal(new URL(url).searchParams.get('broker_account_id'), 'eq.account_one');
    assert.equal(new URL(url).searchParams.get('user_id'), 'eq.user_one');
    return new Response(JSON.stringify(rows), { headers: { 'Content-Type': 'application/json' } });
  });
  const result = await learningRead(db.from('learning').select('*')
    .eq('broker_account_id', 'account_one').eq('user_id', 'user_one'));
  assert.equal(result.error, null);
  assert.deepEqual(result.data, rows);
});

test('an aborted read stops without retries and remains an error', async () => {
  const controller = new AbortController();
  let requests = 0;
  const db = client(async (_, init) => {
    requests++;
    assert.equal(init.signal, controller.signal);
    controller.abort();
    throw controller.signal.reason;
  });
  const result = await learningRead(db.from('learning').select('*'), controller.signal);
  assert.equal(requests, 1);
  assert.ok(result.error);
});

test('single-flight shares matching work without caching results or merging accounts', async () => {
  const read = createSingleFlight();
  let work = 0;
  const query = async () => { work++; return work; };
  const values = await Promise.all([read('account-one', query), read('account-one', query), read('account-two', query)]);
  assert.deepEqual(values, [1, 1, 2]);
  await read('account-one', query);
  assert.equal(work, 3);
});

test('failed single-flight work is released for recovery on the next scan', async () => {
  const read = createSingleFlight();
  let calls = 0;
  const query = async () => { if (++calls === 1) throw new Error('outage'); return 'recovered'; };
  const values = await Promise.allSettled([read('account', query), read('account', query)]);
  assert.ok(values.every((result) => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(await read('account', query), 'recovered');
});
