'use strict';
// server-brain/pm2-bridge.js
// Single PM2 connection owner. All PM2 operations route through here.
// connect() is idempotent — safe to call multiple times, only connects once.

const pm2 = require('pm2');

let _connected = false;

async function connect() {
  if (_connected) return;
  await new Promise((resolve, reject) => {
    pm2.connect(err => {
      if (err) return reject(err);
      _connected = true;
      resolve();
    });
  });
}

function list() {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => (err ? reject(err) : resolve(list)));
  });
}

function start(opts) {
  return new Promise((resolve, reject) => {
    pm2.start(opts, (err, apps) => (err ? reject(err) : resolve(apps)));
  });
}

function stop(name) {
  return new Promise((resolve, reject) => {
    pm2.stop(name, err => (err ? reject(err) : resolve()));
  });
}

function del(name) {
  return new Promise((resolve, reject) => {
    pm2.delete(name, err => (err ? reject(err) : resolve()));
  });
}

function restart(name) {
  return new Promise((resolve, reject) => {
    pm2.restart(name, err => (err ? reject(err) : resolve()));
  });
}

// Delete PM2 entries in errored/one-launch-crash state only.
// Intentionally stopped services are left alone.
async function reapGhosts() {
  const procs = await list().catch(() => []);
  let reaped = 0;
  for (const proc of procs) {
    const status = proc.pm2_env?.status;
    if (status === 'errored' || status === 'one-launch-crash') {
      await del(proc.name).catch(() => {});
      reaped++;
    }
  }
  return reaped;
}

module.exports = { connect, list, start, stop, del, restart, reapGhosts };
