/**
 * Background learning reads must not multiply load during a Data API outage.
 * The pinned supabase-js versions expose retry(false) on queries, but do not
 * forward createClient's db.retry option to PostgREST. Use the query API.
 * This helper does not cache results or change the caller's error handling.
 */
export function learningRead(query, signal = AbortSignal.timeout(10_000)) {
  return query.retry(false).abortSignal(signal);
}

/** Share only overlapping work. Failures are removed so the next scan can retry. */
export function createSingleFlight() {
  const pending = new Map();
  return function singleFlight(key, work) {
    if (pending.has(key)) return pending.get(key);
    const result = Promise.resolve().then(work).finally(() => pending.delete(key));
    pending.set(key, result);
    return result;
  };
}
