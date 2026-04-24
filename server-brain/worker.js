'use strict';
// server-brain/worker.js
// Pings the KV worker every 30s to confirm it's reachable.
// Writes a memory/status snapshot to KV every 30s so crash history
// survives container restarts — you can see what happened before the crash.

const TICK_MS       = 30_000;
const HEARTBEAT_KEY = 'brain:heartbeat';
const METRICS_KEY   = 'brain:metrics:latest';
const HISTORY_KEY   = 'brain:metrics:history';
const MAX_HISTORY   = 60; // 60 snapshots × 30s = 30 minutes of history

class WorkerBridge {
  constructor(kv, brain) {
    this._kv      = kv;
    this._brain   = brain;
    this._timer   = null;
    this._failing = 0;
  }

  start() {
    // Stagger the first tick by 5s so init finishes before we write
    setTimeout(() => {
      this._tick().catch(() => {});
      this._timer = setInterval(() => this._tick().catch(() => {}), TICK_MS);
    }, 5000);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _tick() {
    try {
      // Heartbeat
      await this._kv.set(HEARTBEAT_KEY, String(Date.now()));
      if (this._failing >= 2) {
        // Recovered — notify dashboard
        this._brain.broadcast({
          type: 'brain',
          event: 'worker_recovered',
          message: 'Worker KV connection restored.',
        });
      }
      this._failing = 0;

      // Snapshot
      const snapshot = this._brain.getSnapshot();
      await this._kv.set(METRICS_KEY, JSON.stringify(snapshot));

      // Append to history ring buffer
      let history = [];
      try {
        const raw = await this._kv.get(HISTORY_KEY);
        if (raw) history = JSON.parse(raw);
      } catch {}

      history.push(snapshot);
      if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
      await this._kv.set(HISTORY_KEY, JSON.stringify(history));

    } catch {
      this._failing++;
      if (this._failing === 2) {
        this._brain.broadcast({
          type: 'brain',
          event: 'worker_unreachable',
          message: 'Worker KV unreachable — metrics will not persist until connection recovers.',
        });
      }
    }
  }
}

module.exports = { WorkerBridge };
