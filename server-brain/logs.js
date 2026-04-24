'use strict';
// server-brain/logs.js
// One active tail per service — kills the old one before opening a new one.
// Log rotation at 5MB (keeps last 1000 lines).
// Startup capture buffer: first 50 lines of output from every start.

const fs   = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const LOG_DIR        = '/var/log/firekid';
const MAX_LOG_BYTES  = 5 * 1024 * 1024; // 5MB
const KEEP_LINES     = 1000;
const CAPTURE_LINES  = 50;

class LogManager {
  constructor() {
    // Map<serviceId, { out: ChildProcess, err: ChildProcess }>
    this._tails = new Map();
    // Map<serviceId, string[]> — captured startup lines
    this._buffers = new Map();
  }

  // ─── File helpers ──────────────────────────────────────────────────────────

  outFile(serviceId) { return path.join(LOG_DIR, `${serviceId}.out.log`); }
  errFile(serviceId) { return path.join(LOG_DIR, `${serviceId}.err.log`); }

  ensureFiles(serviceId) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const o = this.outFile(serviceId);
    const e = this.errFile(serviceId);
    if (!fs.existsSync(o)) fs.writeFileSync(o, '');
    if (!fs.existsSync(e)) fs.writeFileSync(e, '');
  }

  // ─── Rotation ─────────────────────────────────────────────────────────────

  _rotateFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return false;
      const stat = fs.statSync(filePath);
      if (stat.size < MAX_LOG_BYTES) return false;
      const lines   = fs.readFileSync(filePath, 'utf-8').split('\n');
      const trimmed = lines.slice(-KEEP_LINES).join('\n');
      fs.writeFileSync(filePath, trimmed);
      return true;
    } catch {
      return false;
    }
  }

  rotate(serviceId) {
    this._rotateFile(this.outFile(serviceId));
    this._rotateFile(this.errFile(serviceId));
  }

  // Rotate ALL log files in LOG_DIR. Called by the background reaper.
  rotateAll() {
    try {
      if (!fs.existsSync(LOG_DIR)) return 0;
      let rotated = 0;
      for (const f of fs.readdirSync(LOG_DIR)) {
        if (!f.endsWith('.log')) continue;
        if (this._rotateFile(path.join(LOG_DIR, f))) rotated++;
      }
      return rotated;
    } catch {
      return 0;
    }
  }

  // ─── Tail management ──────────────────────────────────────────────────────

  killTail(serviceId) {
    const existing = this._tails.get(serviceId);
    if (!existing) return;
    try { existing.out.kill('SIGKILL'); } catch {}
    try { existing.err.kill('SIGKILL'); } catch {}
    this._tails.delete(serviceId);
  }

  killAll() {
    for (const id of this._tails.keys()) this.killTail(id);
  }

  // ─── SSE pipe ─────────────────────────────────────────────────────────────

  // Attach live log streaming to an SSE response.
  // Always kills any existing tail for this service first.
  pipe(serviceId, req, res) {
    this.ensureFiles(serviceId);
    this.rotate(serviceId);
    this.killTail(serviceId); // One tail per service — no ghost tails

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (type, message) => {
      try {
        res.write(`data: ${JSON.stringify({ type, message, time: Date.now() })}\n\n`);
      } catch {}
    };

    // 1. Flush startup capture buffer (lines collected before any viewer connected)
    const buf = this._buffers.get(serviceId) || [];
    buf.forEach(line => send('out', line));

    // 2. Replay last 100 lines from the log files
    try {
      const outLines = fs.readFileSync(this.outFile(serviceId), 'utf-8').split('\n');
      outLines.slice(-100).forEach(l => l && send('out', l));
      const errLines = fs.readFileSync(this.errFile(serviceId), 'utf-8').split('\n');
      errLines.slice(-50).forEach(l => l && send('err', l));
    } catch {}

    // 3. Tail live output
    const tailOut = spawn('tail', ['-f', '-n', '0', this.outFile(serviceId)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const tailErr = spawn('tail', ['-f', '-n', '0', this.errFile(serviceId)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    tailOut.stdout.on('data', d =>
      d.toString().split('\n').filter(Boolean).forEach(l => send('out', l))
    );
    tailErr.stdout.on('data', d =>
      d.toString().split('\n').filter(Boolean).forEach(l => send('err', l))
    );

    // Prevent lingering tails if child exits on its own
    tailOut.on('exit', () => { if (this._tails.get(serviceId)?.out === tailOut) this._tails.delete(serviceId); });
    tailErr.on('exit', () => {});

    this._tails.set(serviceId, { out: tailOut, err: tailErr });

    // Cleanup on client disconnect
    req.on('close', () => {
      this.killTail(serviceId);
    });
  }

  // ─── Startup capture ──────────────────────────────────────────────────────

  // Append a line to the startup buffer for this service.
  captureStartupLine(serviceId, line) {
    if (!this._buffers.has(serviceId)) this._buffers.set(serviceId, []);
    const buf = this._buffers.get(serviceId);
    buf.push(line);
    if (buf.length > CAPTURE_LINES) buf.shift();
  }

  clearBuffer(serviceId) {
    this._buffers.delete(serviceId);
  }
}

module.exports = { LogManager };
