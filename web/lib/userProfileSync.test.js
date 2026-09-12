import test from 'node:test';
import assert from 'node:assert/strict';
import { createUserProfileSync } from './userProfileSync.js';

const user = { clerkUserId: 'user_one', email: 'one@example.test' };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('concurrent dashboard visits share one write and success expires after five minutes', async () => {
  let now = 100;
  let writes = 0;
  const done = deferred();
  const sync = createUserProfileSync(() => { writes++; return done.promise; }, { now: () => now });
  const visits = Array.from({ length: 30 }, () => sync(user));
  await Promise.resolve();
  assert.equal(writes, 1);
  done.resolve();
  await Promise.all(visits);
  now += 299_999;
  await sync(user);
  assert.equal(writes, 1);
  now++;
  await sync(user);
  assert.equal(writes, 2);
});

test('user IDs isolate cache entries even when email addresses match', async () => {
  const written = [];
  const sync = createUserProfileSync(async (profile) => written.push(profile));
  await sync(user);
  await sync({ ...user, clerkUserId: 'user_two' });
  assert.deepEqual(written.map((profile) => profile.clerkUserId), ['user_one', 'user_two']);
});

test('email changes are serialized after an in-flight old profile', async () => {
  const first = deferred();
  const written = [];
  const sync = createUserProfileSync(async (profile) => {
    written.push(profile.email);
    if (written.length === 1) await first.promise;
  });
  const oldVisit = sync(user);
  const newVisit = sync({ ...user, email: 'new@example.test' });
  await Promise.resolve();
  assert.deepEqual(written, ['one@example.test']);
  first.resolve();
  await Promise.all([oldVisit, newVisit]);
  assert.deepEqual(written, ['one@example.test', 'new@example.test']);
});

test('a failed write remains a failure during backoff and succeeds on the next eligible visit', async () => {
  let now = 100;
  let writes = 0;
  const outage = new Error('Data API unavailable');
  const sync = createUserProfileSync(async () => {
    writes++;
    if (writes === 1) throw outage;
  }, { now: () => now });
  await assert.rejects(sync(user), outage);
  now += 29_999;
  await assert.rejects(sync(user), outage);
  assert.equal(writes, 1);
  now++;
  await sync(user);
  assert.equal(writes, 2);
});

test('a changed profile bypasses an old profile failure', async () => {
  const sync = createUserProfileSync(async (profile) => {
    if (profile.email === user.email) throw new Error('failed');
  });
  await assert.rejects(sync(user));
  await sync({ ...user, email: 'changed@example.test' });
});

test('cache size is bounded and evicted users write again', async () => {
  let writes = 0;
  const sync = createUserProfileSync(async () => { writes++; }, { maxEntries: 2 });
  await sync(user);
  await sync({ ...user, clerkUserId: 'user_two' });
  await sync({ ...user, clerkUserId: 'user_three' });
  await sync(user);
  assert.equal(writes, 4);
});

test('missing identity is rejected without accessing the database', async () => {
  const sync = createUserProfileSync(() => assert.fail('must not write'));
  await assert.rejects(sync({ clerkUserId: '', email: user.email }), /Missing Clerk user ID/);
});
