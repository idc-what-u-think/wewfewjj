'use strict';
// server-brain/crash.js
// Per-service crash budget: 3 crashes in 60 minutes → suspended.
// Backoff: delay doubles each crash (2s → 4s → 8s).
// Suspension is written to D1 immediately so it survives container restarts.

const CRASH_WINDOW_MS = 60 * 60 * 1000; // 1 hour sliding window
const MAX_CRASHES     = 3;
const BACKOFF_BASE_MS = 2000; // First retry after 2s, then 4s, 8s…

class CrashTracker {
  constructor(d1) {
    this._d1 = d1;
    // Map<serviceId, number[]> — array of crash timestamps in ms
    this._crashes = new Map();
  }

  // Call this whenever PM2 reports a process crash or memory-kill.
  // Returns { suspended: bool, crashes: number, backoffMs: number }
  async record(serviceId) {
    const now    = Date.now();
    const history = this._pruned(serviceId, now);
    history.push(now);
    this._crashes.set(serviceId, history);

    const count     = history.length;
    const backoffMs = BACKOFF_BASE_MS * Math.pow(2, Math.min(count - 1, 5)); // cap at 2^5 = 64s

    if (count >= MAX_CRASHES) {
      await this._suspend(serviceId);
      return { suspended: true, crashes: count, backoffMs };
    }

    return { suspended: false, crashes: count, backoffMs };
  }

  // Clear crash history — call on every successful manual start.
  clear(serviceId) {
    this._crashes.delete(serviceId);
  }

  // Current crash count within the window (no mutation).
  count(serviceId) {
    return this._pruned(serviceId, Date.now()).length;
  }

  isSuspended(serviceId) {
    return this.count(serviceId) >= MAX_CRASHES;
  }

  // ─── private ─────────────────────────────────────────────────────────────

  _pruned(serviceId, now) {
    const raw = this._crashes.get(serviceId) || [];
    return raw.filter(t => now - t < CRASH_WINDOW_MS);
  }

  async _suspend(serviceId) {
    await this._d1
      .query(
        `UPDATE services SET status = 'suspended', updated_at = datetime('now') WHERE id = ?`,
        [serviceId]
      )
      .catch(() => {}); // Non-fatal — still suspended in memory
  }
}

module.exports = { CrashTracker, MAX_CRASHES, CRASH_WINDOW_MS, BACKOFF_BASE_MS };
