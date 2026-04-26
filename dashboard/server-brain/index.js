'use strict';
// server-brain/index.js
// The Brain — owns the full service lifecycle.
// Dashboard delegates all start/stop/restart/GC decisions here.
// Exports a singleton: require('../server-brain') gives you the same instance everywhere.

const fs   = require('fs');
const path = require('path');

const pm2Bridge  = require('./pm2-bridge');
const memMod     = require('./memory');
const { CrashTracker }   = require('./crash');
const { StartQueue, validateService, checkRAMGate, checkPortFree } = require('./startup');
const { LogManager }     = require('./logs');
const { WorkerBridge }   = require('./worker');

const SERVICES_DIR = process.env.SERVICES_DIR || '/services';

// ─── WebSocket OPEN constant (avoid importing 'ws' just for this) ─────────────
const WS_OPEN = 1;

class Brain {
  constructor() {
    // Dependencies — set in init()
    this._d1  = null;
    this._kv  = null;
    this._wss = null;

    // Sub-modules
    this._trends  = new memMod.TrendTracker();
    this._crashes = null; // Needs d1 — created in init()
    this._queue   = new StartQueue();
    this._logs    = new LogManager();
    this._worker  = null; // Needs kv + this — created in init()

    // Active service registry
    // Map<serviceId, { pid: number, maxMB: number, name: string }>
    this._services = new Map();

    // Memory kill — track pending SIGKILL timers so we can clear them if needed
    // Map<serviceId, TimeoutId>
    this._killTimers = new Map();

    // Internal event log (voice)
    this._events    = [];
    this._maxEvents = 100;
    this._notify    = () => {};

    // Default max memory per service (overridden by D1 settings on init)
    this._defaultMaxMB = 200;

    // Background timer handles
    this._memTimer    = null;
    this._reaperTimer = null;

    this._ready = false;
  }

  // ─── Init ──────────────────────────────────────────────────────────────────

  async init({ d1, kv, wss, notify }) {
    this._d1     = d1;
    this._kv     = kv;
    this._wss    = wss;
    this._notify = notify || (() => {});

    this._crashes = new CrashTracker(d1);
    this._worker  = new WorkerBridge(kv, this);

    // Single PM2 connection — never called again after this
    await pm2Bridge.connect();

    // Read max_memory_mb setting from D1 (default 200)
    try {
      const r = await d1.query(`SELECT value FROM settings WHERE key = 'max_memory_mb'`);
      const val = parseInt(r.results?.[0]?.value || '200', 10);
      if (!isNaN(val) && val > 50) this._defaultMaxMB = val;
    } catch {}

    this._ready = true;
    this._log('info', `Brain online. Default memory cap: ${this._defaultMaxMB}MB per service.`);

    // Start background loops
    this._memTimer    = setInterval(() => this._memoryPoll().catch(() => {}), memMod.SAMPLE_INTERVAL_MS);
    this._reaperTimer = setInterval(() => this._reap().catch(() => {}), 60_000);
    this._worker.start();

    // Cleanup on process exit
    process.once('SIGTERM', () => this.shutdown());
    process.once('SIGINT',  () => this.shutdown());
  }

  // ─── Service registration ─────────────────────────────────────────────────

  // Called after a successful PM2 start to register the service for monitoring.
  _registerService(serviceId, pid, maxMB, name) {
    this._services.set(serviceId, { pid, maxMB: maxMB || this._defaultMaxMB, name: name || serviceId });
  }

  _unregisterService(serviceId) {
    this._services.delete(serviceId);
    this._trends.clear(serviceId);

    // Cancel any pending SIGKILL timer for this service
    const timer = this._killTimers.get(serviceId);
    if (timer) {
      clearTimeout(timer);
      this._killTimers.delete(serviceId);
    }
  }

  // ─── Start ────────────────────────────────────────────────────────────────

  async startService(svc) {
    const validation = validateService(svc, SERVICES_DIR);
    if (!validation.ok) throw new Error(validation.reason);

    // Skip port check if this service is already holding the port
    const procs = await pm2Bridge.list().catch(() => []);
    const existing = procs.find(p => p.name === svc.id);
    if (existing?.pm2_env?.status !== 'online') {
      const portCheck = await checkPortFree(svc.port);
      if (!portCheck.ok) throw new Error(portCheck.reason);
    }

    return this._queue.enqueue(async () => {
      const ram = checkRAMGate();
      if (!ram.ok) throw new Error(ram.reason);
      this._crashes.clear(svc.id);
      await this._doStart(svc);
    });
  }

  async _doStart(svc) {
    const dir     = path.join(SERVICES_DIR, svc.id);
    const envVars = {};

    // Load env_vars from DB
    try { Object.assign(envVars, JSON.parse(svc.env_vars || '{}')); } catch {}

    // Merge .env file if present
    const envFile = path.join(dir, '.env');
    if (fs.existsSync(envFile)) {
      try {
        fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
          const [key, ...vals] = line.split('=');
          if (key && key.trim()) envVars[key.trim()] = vals.join('=').trim();
        });
      } catch {}
    }

    fs.mkdirSync('/var/log/firekid', { recursive: true });

    // Per-service memory cap
    const maxMB  = (svc.max_memory_mb && parseInt(svc.max_memory_mb, 10) > 0)
      ? parseInt(svc.max_memory_mb, 10)
      : this._defaultMaxMB;
    const heapMB = Math.max(64, maxMB - 20);

    // ── Correctly parse start_command into PM2 options ───────────────────────
    // PM2 rule: interpreter = binary, script = file passed to it
    // "node index.js"   → interpreter:'node',  script:'index.js'
    // "npm run start"   → interpreter:'none',  script:'npm', args:['run','start']
    // "./start.sh"      → interpreter:'none',  script:'./start.sh'
    const INTERPRETERS = ['node', 'python', 'python3', 'bun', 'ts-node', 'deno', 'php', 'ruby', 'perl'];
    const PKG_RUNNERS  = ['npm', 'yarn', 'pnpm'];
    const rawParts = svc.start_command.trim().split(/\s+/);
    let script, args, interpreter, nodeArgs;

    if (INTERPRETERS.includes(rawParts[0])) {
      interpreter = rawParts[0];
      script      = rawParts[1];
      args        = rawParts.slice(2);
      nodeArgs    = interpreter === 'node' ? [`--max-old-space-size=${heapMB}`] : undefined;
    } else if (PKG_RUNNERS.includes(rawParts[0])) {
      interpreter = 'none';
      script      = rawParts[0];
      args        = rawParts.slice(1);
      nodeArgs    = undefined;
    } else {
      interpreter = 'none';
      script      = rawParts[0];
      args        = rawParts.slice(1);
      nodeArgs    = undefined;
    }

    // Delete ghost entry before starting fresh
    await pm2Bridge.del(svc.id).catch(() => {});

    await pm2Bridge.start({
      name:        svc.id,
      script,
      args:        args.length ? args : undefined,
      interpreter,
      node_args:   nodeArgs,
      cwd:         dir,
      env:         { ...process.env, ...envVars, PORT: String(svc.port) },
      autorestart:               svc.auto_restart === 1,
      max_restarts:              3,
      min_uptime:                3000,
      exp_backoff_restart_delay: 3000,
      max_memory_restart:        `${maxMB}M`,
      kill_timeout:              5000,
      out_file:   `/var/log/firekid/${svc.id}.out.log`,
      error_file: `/var/log/firekid/${svc.id}.err.log`,
      merge_logs: true,
    });

    // pm2.start() resolves on ACK not on online — poll up to 8s for real status
    let proc = null;
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const list = await pm2Bridge.list().catch(() => []);
      proc = list.find(p => p.name === svc.id);
      if (proc?.pm2_env?.status === 'online' && proc.pid) break;
      if (proc?.pm2_env?.status === 'errored' || proc?.pm2_env?.status === 'one-launch-crash') {
        throw new Error(`Process failed immediately (status: ${proc.pm2_env.status}). Check Logs tab.`);
      }
    }

    if (proc?.pid) {
      this._registerService(svc.id, proc.pid, maxMB, svc.name);
    }

    await this._d1.query(
      `UPDATE services SET status = 'running', updated_at = datetime('now') WHERE id = ?`,
      [svc.id]
    ).catch(() => {});

    this._log('info', `Started "${svc.name}" (cap: ${maxMB}MB). Container: ${memMod.freeContainerMB()}MB free.`);
  }

  // ─── Stop ─────────────────────────────────────────────────────────────────

  async stopService(svc) {
    try { await pm2Bridge.stop(svc.id); }  catch {}
    try { await pm2Bridge.del(svc.id); }   catch {}
    this._unregisterService(svc.id);
    this._logs.killTail(svc.id);

    await this._d1.query(
      `UPDATE services SET status = 'stopped', updated_at = datetime('now') WHERE id = ?`,
      [svc.id]
    ).catch(() => {});

    this._log('info', `Stopped "${svc.name}".`);
  }

  // ─── Restart ──────────────────────────────────────────────────────────────

  async restartService(svc) {
    // Clear crash budget so a manual restart gives the service a clean slate
    this._crashes.clear(svc.id);

    try {
      await pm2Bridge.restart(svc.id);
      // Update PID after restart
      const procs = await pm2Bridge.list().catch(() => []);
      const proc  = procs.find(p => p.name === svc.id);
      if (proc?.pid) {
        const existing = this._services.get(svc.id);
        this._registerService(svc.id, proc.pid, existing?.maxMB || this._defaultMaxMB, svc.name);
      }
      this._log('info', `Restarted "${svc.name}".`);
    } catch {
      // PM2 doesn't know about this service — do a full start
      await this.startService(svc);
    }
  }

  // ─── Memory polling (every 10s) ───────────────────────────────────────────

  async _memoryPoll() {
    for (const [serviceId, info] of this._services) {
      const mb = memMod.getProcessMemoryMB(info.pid);
      if (mb === null) {
        // Process is gone — unregister so we stop polling it
        this._unregisterService(serviceId);
        continue;
      }

      this._trends.record(serviceId, mb);

      const maxMB = info.maxMB;

      if (mb >= maxMB) {
        // ── Hard tier: brain kills faster than PM2's 30s poll ──────────────
        this._log('warn', `[${info.name}] Hard limit hit: ${mb}MB / ${maxMB}MB. Terminating.`);
        this.broadcast({
          type: 'brain', event: 'memory_hard', serviceId,
          message: `${info.name} hit ${mb}MB (limit ${maxMB}MB). Restarting.`,
        });
        this._notify('crash', { name: info.name, message: `Memory hard limit: ${mb}MB / ${maxMB}MB` }).catch?.(() => {});

        // Cancel any existing kill timer for this service
        const existing = this._killTimers.get(serviceId);
        if (existing) clearTimeout(existing);

        try { process.kill(info.pid, 'SIGTERM'); } catch {}

        // Fallback SIGKILL after 5s if SIGTERM didn't work
        const timer = setTimeout(() => {
          try { process.kill(info.pid, 'SIGKILL'); } catch {}
          this._killTimers.delete(serviceId);
        }, 5000);
        this._killTimers.set(serviceId, timer);

        // Record crash — may suspend the service
        const result = await this._crashes.record(serviceId);
        if (result.suspended) {
          this._log('warn', `[${info.name}] Suspended. ${result.crashes} crashes in the last hour.`);
          this.broadcast({
            type: 'brain', event: 'suspended', serviceId,
            message: `"${info.name}" suspended. Crashed ${result.crashes}× in 1 hour. Start it manually when ready.`,
          });
          // Remove from PM2 so it doesn't auto-restart into another loop
          await pm2Bridge.del(serviceId).catch(() => {});
          await this._d1.query(
            `UPDATE services SET status = 'suspended', updated_at = datetime('now') WHERE id = ?`,
            [serviceId]
          ).catch(() => {});
        }

        this._unregisterService(serviceId);

      } else if (mb >= memMod.WARN_MB) {
        // ── Warn tier ──────────────────────────────────────────────────────
        this.broadcast({
          type: 'brain', event: 'memory_warn', serviceId, mb, maxMB,
          message: `"${info.name}" at ${mb}MB — approaching ${maxMB}MB limit.`,
        });

      } else if (mb >= memMod.SOFT_MB || this._trends.isRising(serviceId)) {
        // ── Soft tier: log + notify (no process action) ────────────────────
        this.broadcast({
          type: 'brain', event: 'memory_soft', serviceId, mb,
          message: `"${info.name}" at ${mb}MB${this._trends.isRising(serviceId) ? ' (trending up)' : ''}.`,
        });
      }
    }
  }

  // ─── Ghost reaper (every 60s) ─────────────────────────────────────────────

  async _reap() {
    const ghosts  = await pm2Bridge.reapGhosts();
    const rotated = this._logs.rotateAll();

    // Force a GC pass on the dashboard process itself
    if (typeof global.gc === 'function') global.gc();

    if (ghosts > 0 || rotated > 0) {
      this._log('info', `Reaper: ${ghosts} PM2 ghosts removed, ${rotated} log files rotated.`);
    }
  }

  // ─── Manual GC endpoint ───────────────────────────────────────────────────

  async gc() {
    const result = {
      pm2Ghosts:    0,
      servicesGCd:  0,
      logsRotated:  0,
      dashboardGC:  false,
    };

    result.pm2Ghosts   = await pm2Bridge.reapGhosts();
    result.logsRotated = this._logs.rotateAll();

    // PM2 processes can receive SIGUSR2 for graceful reload — but we can't
    // externally force GC in another Node process without --expose-gc on THAT process.
    // What we CAN do is track them and log count.
    result.servicesGCd = this._services.size;

    // GC the dashboard process itself (requires --expose-gc in start.sh)
    if (typeof global.gc === 'function') {
      global.gc();
      result.dashboardGC = true;
    }

    const freed = `${result.pm2Ghosts} PM2 ghosts · ${result.logsRotated} logs trimmed · Dashboard GC: ${result.dashboardGC}`;
    this._log('info', `Manual clean: ${freed}`);
    this.broadcast({ type: 'brain', event: 'gc_complete', ...result, freed });

    return result;
  }

  // ─── Logs ─────────────────────────────────────────────────────────────────

  pipeLogs(serviceId, req, res) {
    this._logs.pipe(serviceId, req, res);
  }

  // ─── Snapshot (for worker metrics persistence) ────────────────────────────

  getSnapshot() {
    const container = memMod.getContainerMemory();
    const services  = [];
    for (const [id, info] of this._services) {
      services.push({
        id,
        name:      info.name,
        pid:       info.pid,
        memoryMB:  this._trends.latest(id) || 0,
        crashes:   this._crashes.count(id),
        maxMB:     info.maxMB,
      });
    }
    return {
      ts:               Date.now(),
      containerUsedMB:  Math.floor(container.usedBytes  / 1024 / 1024),
      containerFreeMB:  Math.floor(container.freeBytes  / 1024 / 1024),
      containerLimitMB: Math.floor(container.limitBytes / 1024 / 1024),
      services,
      recentEvents: this._events.slice(-10),
    };
  }

  getMetricsHistory() {
    return this._worker ? this._worker.getHistory() : [];
  }

  // ─── Broadcast to all connected WS clients ────────────────────────────────

  broadcast(payload) {
    if (!this._wss) return;
    const msg = JSON.stringify(payload);
    this._wss.clients.forEach(client => {
      if (client.readyState === WS_OPEN) {
        try { client.send(msg); } catch {}
      }
    });
  }

  // ─── Internal voice / event log ───────────────────────────────────────────

  _log(level, message) {
    const entry = { ts: Date.now(), level, message };
    this._events.push(entry);
    if (this._events.length > this._maxEvents) this._events.shift();
    console.log(`[brain][${level}] ${message}`);
    this.broadcast({ type: 'brain', event: 'log', ...entry });
  }

  getEvents() {
    return [...this._events];
  }

  // ─── Shutdown cleanup ─────────────────────────────────────────────────────

  shutdown() {
    if (this._memTimer)    { clearInterval(this._memTimer);    this._memTimer    = null; }
    if (this._reaperTimer) { clearInterval(this._reaperTimer); this._reaperTimer = null; }
    for (const [, timer] of this._killTimers) clearTimeout(timer);
    this._killTimers.clear();
    if (this._worker) this._worker.stop();
    this._logs.killAll();
  }
}

// ─── Singleton export ─────────────────────────────────────────────────────────
module.exports = new Brain();
