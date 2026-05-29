/**
 * server/requestContext.js
 *
 * Per-request "strict mode" gate for user-authenticated paths on the Railway
 * scanner. Every `/api/internal/oanda/*` endpoint wraps the handler in
 * `runUserScoped({ accountId, environment }, () => …)` which:
 *
 *   1. Stores the expected accountId + environment in AsyncLocalStorage so any
 *      downstream OANDA helper can verify it's executing under the right user.
 *   2. Forbids the default env-based OANDA client. If any helper falls back to
 *      `getDefaultClient()` while strict mode is active, the call throws —
 *      preventing the silent leak where a missing `{ client }` argument routes
 *      a tester's request to the platform's env credentials.
 *
 * This is defense-in-depth on top of the per-request `createOandaClient` flow.
 * Even if a future refactor forgets to thread `{ client }` through a helper,
 * the strict guard surfaces the bug as a hard error instead of silently
 * scanning against my account.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run `fn` inside a request scope where the default env-based OANDA client is
 * forbidden. The scope is tied to the async stack, so anything awaited inside
 * `fn` (or its children) inherits the strict flag.
 *
 * @param {Object} ctx
 * @param {string} ctx.accountId    — expected OANDA accountId for this request
 * @param {string} ctx.environment  — 'practice' | 'live'
 * @param {string} [ctx.clerkUserId]— for log correlation only
 * @param {() => Promise<any>} fn
 */
export function runUserScoped(ctx, fn) {
  return storage.run({ ...ctx, requireUserClient: true }, fn);
}

/** Returns the current request context, or `undefined` outside a user scope. */
export function getRequestContext() {
  return storage.getStore();
}

/** True when the current async stack is inside `runUserScoped`. */
export function isStrictUserPath() {
  return Boolean(storage.getStore()?.requireUserClient);
}
