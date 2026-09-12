/**
 * A bounded, process-local cache for optional Clerk shadow-profile writes.
 * It never authenticates a user or caches authorization/broker data.
 * A new instance, changed email, or expired success entry writes again.
 */
export function createUserProfileSync(write, {
  now = Date.now,
  successTtlMs = 300_000,
  failureTtlMs = 30_000,
  maxEntries = 1000,
} = {}) {
  const completed = new Map();
  const pending = new Map();

  function remember(id, entry) {
    completed.delete(id);
    completed.set(id, entry);
    while (completed.size > maxEntries) {
      completed.delete(completed.keys().next().value);
    }
  }

  function sync(user) {
    if (!user.clerkUserId) return Promise.reject(new Error('Missing Clerk user ID'));
    // Snapshot inputs: a caller cannot change a queued write after it starts.
    const profile = { clerkUserId: user.clerkUserId, email: user.email };
    const id = profile.clerkUserId;
    const active = pending.get(id);
    if (active) {
      if (active.email === profile.email) return active.promise;
      // Serialize email changes so an older write cannot overwrite the new one.
      return active.promise.catch(() => {}).then(() => sync(profile));
    }
    const previous = completed.get(id);
    if (previous?.email === profile.email && now() < previous.expiresAt) {
      return previous.failed ? Promise.reject(previous.error) : Promise.resolve();
    }
    const promise = Promise.resolve()
      .then(() => write(profile))
      .then(() => {
        remember(id, { email: profile.email, expiresAt: now() + successTtlMs, failed: false });
      }, (error) => {
        // Preserve the failure for callers, but stop repeated dashboard visits
        // from resubmitting the same optional write during a database outage.
        remember(id, { email: profile.email, expiresAt: now() + failureTtlMs, failed: true, error });
        throw error;
      })
      .finally(() => pending.delete(id));
    pending.set(id, { email: profile.email, promise });
    return promise;
  }

  return sync;
}
