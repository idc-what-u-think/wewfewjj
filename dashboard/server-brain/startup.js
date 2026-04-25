'use strict';
// server-brain/startup.js
// Pre-start validation + stagger queue.
// Services start 8s apart so memory climbs gradually and stays observable.
// Every start checks: script dir exists, node_modules present, port free, RAM available.

const fs   = require('fs');
const path = require('path');
const net  = require('net');
const { freeContainerMB } = require('./memory');

const STAGGER_MS  = 8000; // Gap between consecutive service starts
const MIN_FREE_MB = 200;  // Refuse start if free RAM drops below this

// ─── Validators ───────────────────────────────────────────────────────────────

function validateService(svc, servicesDir) {
  const dir = path.join(servicesDir, svc.id);

  if (!fs.existsSync(dir)) {
    return { ok: false, reason: `Service directory not found. Click Deploy first.` };
  }

  const lang = (svc.language || 'node').toLowerCase();
  if (lang === 'node') {
    const hasPkg  = fs.existsSync(path.join(dir, 'package.json'));
    const hasMods = fs.existsSync(path.join(dir, 'node_modules'));
    if (hasPkg && !hasMods) {
      return {
        ok: false,
        reason: `node_modules missing. Click Deploy to install dependencies first.`,
      };
    }
  }

  return { ok: true };
}

// Checks actual container free RAM (cgroup-aware via memory.js).
function checkRAMGate() {
  const free = freeContainerMB();
  if (free < MIN_FREE_MB) {
    return {
      ok: false,
      reason: `Not enough memory to start safely. ${free}MB free, need ${MIN_FREE_MB}MB. Try cleaning RAM first.`,
    };
  }
  return { ok: true, freeMB: free };
}

// Confirms the port isn't already bound by another process.
// Pass skipIfName to allow the port if the only occupant is a known PM2 process.
function checkPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve({ ok: false, reason: `Port ${port} is already in use.` }));
    srv.once('listening', () => {
      srv.close();
      resolve({ ok: true });
    });
    srv.listen(port, '127.0.0.1');
  });
}

// ─── Stagger queue ────────────────────────────────────────────────────────────

class StartQueue {
  constructor() {
    this._queue   = []; // Array<{ fn, resolve, reject }>
    this._running = false;
  }

  // Push a start function onto the queue.
  // Returns a Promise that resolves/rejects when that start completes.
  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      if (!this._running) this._drain();
    });
  }

  async _drain() {
    this._running = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try {
        resolve(await fn());
      } catch (e) {
        reject(e);
      }
      // Wait between starts even if the queue has more items
      if (this._queue.length > 0) {
        await _sleep(STAGGER_MS);
      }
    }
    this._running = false;
  }
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  StartQueue,
  validateService,
  checkRAMGate,
  checkPortFree,
  MIN_FREE_MB,
  STAGGER_MS,
};
