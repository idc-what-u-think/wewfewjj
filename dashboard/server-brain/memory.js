'use strict';
// server-brain/memory.js
// Container-aware memory reading (cgroup v1 + v2, not os.freemem which lies in Docker).
// Per-service trend tracking and three-tier alerting thresholds.

const fs = require('fs');
const os = require('os');

// Alert thresholds (MB). All configurable at brain init time.
const SOFT_MB = 150; // Warn user — memory climbing
const WARN_MB = 180; // Stronger warning — getting close
const HARD_MB = 200; // Kill threshold — brain acts before PM2's slow poll

// Trend: how long memory must be rising continuously before a soft alert fires
const TREND_WINDOW_MS  = 90_000; // 90 seconds
const SAMPLE_INTERVAL_MS = 10_000; // Poll every 10s (vs PM2's 30s)
const MAX_SAMPLES       = 20;     // ~3 minutes of history per service

// ─── Container RAM (cgroup-aware) ────────────────────────────────────────────

function _readFile(p) {
  try {
    const raw = fs.readFileSync(p, 'utf-8').trim();
    if (raw === 'max') return os.totalmem(); // unlimited container — use host total
    const val = parseInt(raw, 10);
    return isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

function getContainerMemory() {
  // cgroup v2
  const v2Used  = _readFile('/sys/fs/cgroup/memory.current');
  const v2Limit = _readFile('/sys/fs/cgroup/memory.max');
  if (v2Used !== null && v2Limit !== null && v2Limit > 0 && v2Limit < 9e18) {
    return {
      usedBytes:  v2Used,
      limitBytes: v2Limit,
      freeBytes:  Math.max(0, v2Limit - v2Used),
    };
  }

  // cgroup v1
  const v1Used  = _readFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const v1Limit = _readFile('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  if (v1Used !== null && v1Limit !== null && v1Limit > 0 && v1Limit < 9e18) {
    return {
      usedBytes:  v1Used,
      limitBytes: v1Limit,
      freeBytes:  Math.max(0, v1Limit - v1Used),
    };
  }

  // Fallback: /proc/meminfo (host values, less accurate inside containers)
  try {
    const info      = fs.readFileSync('/proc/meminfo', 'utf-8');
    const available = (_readFile(null) ?? 0); // won't be used
    const totalKB   = parseInt(info.match(/MemTotal:\s+(\d+)/)?.[1] || '0', 10);
    const availKB   = parseInt(info.match(/MemAvailable:\s+(\d+)/)?.[1] || '0', 10);
    const total     = totalKB * 1024;
    const avail     = availKB * 1024;
    return { usedBytes: total - avail, limitBytes: total, freeBytes: avail };
  } catch {
    // Last resort static fallback — assume 512MB container
    const limit = 512 * 1024 * 1024;
    return { usedBytes: 0, limitBytes: limit, freeBytes: limit };
  }
}

function freeContainerMB() {
  return Math.floor(getContainerMemory().freeBytes / 1024 / 1024);
}

function containerUsedPercent() {
  const m = getContainerMemory();
  if (!m.limitBytes) return 0;
  return Math.round((m.usedBytes / m.limitBytes) * 100);
}

// ─── Per-process RSS from /proc ───────────────────────────────────────────────

function getProcessMemoryMB(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf-8');
    const match  = status.match(/VmRSS:\s+(\d+)/);
    if (!match) return null;
    return Math.floor(parseInt(match[1], 10) / 1024); // kB → MB
  } catch {
    return null; // Process exited — caller handles null
  }
}

// ─── Trend tracker ────────────────────────────────────────────────────────────

class TrendTracker {
  constructor() {
    // Map<serviceId, Array<{ ts: number, mb: number }>>
    this._data = new Map();
  }

  record(serviceId, mb) {
    if (!this._data.has(serviceId)) this._data.set(serviceId, []);
    const samples = this._data.get(serviceId);
    samples.push({ ts: Date.now(), mb });
    // Cap to MAX_SAMPLES to prevent unbounded growth
    if (samples.length > MAX_SAMPLES) samples.shift();
  }

  // Returns true if every sample in the last TREND_WINDOW_MS is strictly rising.
  // Requires at least 3 samples to avoid false positives on startup.
  isRising(serviceId) {
    const samples = this._data.get(serviceId);
    if (!samples || samples.length < 3) return false;
    const cutoff = Date.now() - TREND_WINDOW_MS;
    const recent = samples.filter(s => s.ts >= cutoff);
    if (recent.length < 3) return false;
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].mb <= recent[i - 1].mb) return false;
    }
    return true;
  }

  latest(serviceId) {
    const samples = this._data.get(serviceId);
    if (!samples || !samples.length) return null;
    return samples[samples.length - 1].mb;
  }

  clear(serviceId) {
    this._data.delete(serviceId);
  }
}

module.exports = {
  SOFT_MB,
  WARN_MB,
  HARD_MB,
  SAMPLE_INTERVAL_MS,
  getContainerMemory,
  freeContainerMB,
  containerUsedPercent,
  getProcessMemoryMB,
  TrendTracker,
};
