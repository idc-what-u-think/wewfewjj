'use strict';
// server-brain/worker.js
// Keeps metrics history in memory only — no KV writes.
// KV is only pinged once on startup to confirm reachability, then never again.
// This eliminates ~8,640 KV writes/day that blew through the free tier limit.

const MAX_HISTORY = 120; // 120 snapshots in memory (enough for analysis)

class WorkerBridge {
  constructor(kv, brain) {
    this._kv      = kv;
    this._brain   = brain;
    this._timer   = null;
    this._history = [];
  }

  // Called by brain to get history for /api/brain/metrics
  getHistory() {
    return this._history;
  }

  start() {
    // Ping KV once on startup just to confirm worker is reachable
    setTimeout(() => {
      this._kv.set('brain:heartbeat', String(Date.now()))
        .catch(() => {
          this._brain.broadcast({
            type: 'brain',
            event: 'worker_unreachable',
            message: 'Worker KV unreachable on startup — check WORKER_URL and WORKER_SECRET.',
          });
        });
    }, 5000);

    // Collect snapshots in memory every 60s (no KV writes)
    this._timer = setInterval(() => {
      try {
        const snapshot = this._brain.getSnapshot();
        this._history.push(snapshot);
        if (this._history.length > MAX_HISTORY) {
          this._history = this._history.slice(-MAX_HISTORY);
        }
      } catch {}
    }, 60_000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }
}

module.exports = { WorkerBridge };
