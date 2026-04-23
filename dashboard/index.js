// firekid-server — dashboard backend
// Express server handling auth, proxy, API, terminals, logs, files

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const { createProxyMiddleware } = require('http-proxy-middleware');
const multer = require('multer');
const pty = require('node-pty');
const pm2 = require('pm2');
const axios = require('axios');
const si = require('systeminformation');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { execSync, exec, spawn } = require('child_process');
const simpleGit = require('simple-git');

const app = express();
const server = http.createServer(app);
// noServer = we handle the upgrade manually so session is available in WS
const wss = new WebSocket.Server({ noServer: true });

const PORT = process.env.DASHBOARD_PORT || 3000;
const SERVICES_DIR = process.env.SERVICES_DIR || '/services';
const WORKER_URL = process.env.WORKER_URL;
const WORKER_SECRET = process.env.WORKER_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'changeme';
const DASHBOARD_USERNAME = process.env.DASHBOARD_USERNAME;
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

// ─────────────────────────────────────────────────────
// WORKER HELPERS
// ─────────────────────────────────────────────────────

async function workerRequest(method, endpoint, body = null) {
  const res = await axios({
    method,
    url: `${WORKER_URL}${endpoint}`,
    headers: {
      'X-Worker-Secret': WORKER_SECRET,
      'Content-Type': 'application/json',
    },
    data: body,
    timeout: 10000,
  });
  return res.data;
}

const kv = {
  get: (key) => workerRequest('GET', `/kv/${encodeURIComponent(key)}`).then(r => r.value).catch(() => null),
  set: (key, value, ttl) => workerRequest('POST', `/kv/${encodeURIComponent(key)}`, { value, ttl }),
  del: (key) => workerRequest('DELETE', `/kv/${encodeURIComponent(key)}`),
  list: (prefix) => workerRequest('GET', `/kv-list?prefix=${encodeURIComponent(prefix || '')}`),
};

const d1 = {
  query: (sql, params) => workerRequest('POST', '/d1/query', { sql, params }),
  exec: (sql) => workerRequest('POST', '/d1/exec', { sql }),
  batch: (statements) => workerRequest('POST', '/d1/batch', { statements }),
};

// ─────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 24 * 60 * 60 * 1000 },
});

app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  return res.redirect('/');
}

// ─────────────────────────────────────────────────────
// AUTH ROUTES
// ─────────────────────────────────────────────────────

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === DASHBOARD_USERNAME && password === DASHBOARD_PASSWORD) {
    req.session.authenticated = true;
    req.session.username = username;
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/auth/me', (req, res) => {
  if (req.session && req.session.authenticated) {
    return res.json({ authenticated: true, username: req.session.username });
  }
  res.json({ authenticated: false });
});

// ─────────────────────────────────────────────────────
// PM2 HELPERS
// ─────────────────────────────────────────────────────

function pm2Connect() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => err ? reject(err) : resolve());
  });
}

function pm2List() {
  return new Promise((resolve, reject) => {
    pm2.list((err, list) => err ? reject(err) : resolve(list));
  });
}

function pm2Start(opts) {
  return new Promise((resolve, reject) => {
    pm2.start(opts, (err, apps) => err ? reject(err) : resolve(apps));
  });
}

function pm2Stop(name) {
  return new Promise((resolve, reject) => {
    pm2.stop(name, (err) => err ? reject(err) : resolve());
  });
}

function pm2Delete(name) {
  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => err ? reject(err) : resolve());
  });
}

function pm2Restart(name) {
  return new Promise((resolve, reject) => {
    pm2.restart(name, (err) => err ? reject(err) : resolve());
  });
}

// ─────────────────────────────────────────────────────
// SERVICE HELPERS
// ─────────────────────────────────────────────────────

async function getServices() {
  try {
    const result = await d1.query('SELECT * FROM services ORDER BY created_at ASC');
    return result.results || [];
  } catch {
    return [];
  }
}

async function getService(id) {
  const result = await d1.query('SELECT * FROM services WHERE id = ?', [id]);
  return result.results?.[0] || null;
}

async function getTokens() {
  const result = await d1.query('SELECT id, name, account, note, created_at FROM github_tokens ORDER BY created_at ASC');
  return result.results || [];
}

async function getToken(name) {
  const result = await d1.query('SELECT token FROM github_tokens WHERE name = ?', [name]);
  return result.results?.[0]?.token || null;
}

function getServiceDir(service) {
  return path.join(SERVICES_DIR, service.id);
}

async function cloneOrPullService(service) {
  const dir = getServiceDir(service);
  let repoUrl = service.repo_url;

  if (service.pat_key) {
    const token = await getToken(service.pat_key);
    if (token && repoUrl) {
      repoUrl = repoUrl.replace('https://', `https://${token}@`);
    }
  }

  if (!repoUrl) return { success: false, message: 'No repo URL configured' };

  const git = simpleGit();

  if (fs.existsSync(path.join(dir, '.git'))) {
    await git.cwd(dir).pull('origin', service.branch || 'main');
    return { success: true, message: 'Pulled latest changes' };
  } else {
    fs.mkdirSync(dir, { recursive: true });
    await git.clone(repoUrl, dir, ['--branch', service.branch || 'main', '--depth', '1']);
    return { success: true, message: 'Cloned repository' };
  }
}

function detectLanguage(dir) {
  if (fs.existsSync(path.join(dir, 'package.json'))) return 'node';
  if (fs.existsSync(path.join(dir, 'requirements.txt'))) return 'python';
  if (fs.existsSync(path.join(dir, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(dir, 'build.gradle'))) return 'java';
  if (fs.existsSync(path.join(dir, 'Cargo.toml'))) return 'rust';
  return 'node';
}

function getInstallCommand(language, dir) {
  switch (language) {
    case 'node': {
      if (fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun install';
      if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn install';
      if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm install';
      return 'npm install';
    }
    case 'python': return 'pip install -r requirements.txt';
    case 'go': return 'go mod download';
    default: return null;
  }
}

async function installDeps(service) {
  const dir = getServiceDir(service);
  const lang = service.language || detectLanguage(dir);
  const cmd = getInstallCommand(lang, dir);
  if (!cmd) return;
  await new Promise((resolve, reject) => {
    exec(cmd, { cwd: dir }, (err) => err ? reject(err) : resolve());
  });
}

async function startServiceProcess(service) {
  const dir = getServiceDir(service);
  const envVars = JSON.parse(service.env_vars || '{}');
  const envFile = path.join(dir, '.env');

  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    lines.forEach(line => {
      const [key, ...vals] = line.split('=');
      if (key && key.trim()) envVars[key.trim()] = vals.join('=').trim();
    });
  }

  await pm2Connect();
  await pm2Start({
    name: service.id,
    script: service.start_command,
    cwd: dir,
    env: { ...process.env, ...envVars, PORT: service.port },
    autorestart: service.auto_restart === 1,
    max_restarts: 10,
    min_uptime: '5s',
    exp_backoff_restart_delay: 100,
    out_file: `/var/log/firekid/${service.id}.out.log`,
    error_file: `/var/log/firekid/${service.id}.err.log`,
    merge_logs: true,
  });

  await d1.query('UPDATE services SET status = ?, updated_at = datetime(\'now\') WHERE id = ?', ['running', service.id]);
}

async function stopServiceProcess(service) {
  await pm2Connect();
  try { await pm2Stop(service.id); } catch {}
  try { await pm2Delete(service.id); } catch {}
  await d1.query('UPDATE services SET status = ?, updated_at = datetime(\'now\') WHERE id = ?', ['stopped', service.id]);
}

// ─────────────────────────────────────────────────────
// DYNAMIC PROXY (service routing)
// ─────────────────────────────────────────────────────

const activeProxies = new Map();

async function rebuildProxy() {
  const services = await getServices();
  activeProxies.clear();

  for (const svc of services) {
    if (!svc.path_prefix || !svc.port) continue;
    activeProxies.set(svc.path_prefix, {
      service: svc,
      proxy: createProxyMiddleware({
        target: `http://localhost:${svc.port}`,
        changeOrigin: true,
        pathRewrite: { [`^${svc.path_prefix}`]: '' },
        on: {
          error: (err, req, res) => {
            res.status(502).json({ error: 'Service unavailable', service: svc.name });
          }
        }
      }),
    });
  }
}

app.use(async (req, res, next) => {
  for (const [prefix, { proxy }] of activeProxies) {
    if (req.path.startsWith(prefix + '/') || req.path === prefix) {
      return proxy(req, res, next);
    }
  }
  next();
});

// ─────────────────────────────────────────────────────
// API — SYSTEM STATUS
// ─────────────────────────────────────────────────────

app.get('/api/status', requireAuth, async (req, res) => {
  try {
    const [cpu, mem, disk, osInfo, uptime] = await Promise.all([
      si.currentLoad(),
      si.mem(),
      si.fsSize(),
      si.osInfo(),
      si.time(),
    ]);

    const pm2List_ = await pm2List().catch(() => []);

    res.json({
      cpu: {
        load: Math.round(cpu.currentLoad),
        cores: cpu.cpus?.length || 0,
      },
      memory: {
        total: mem.total,
        used: mem.used,
        free: mem.free,
        percent: Math.round((mem.used / mem.total) * 100),
      },
      disk: {
        total: disk[0]?.size || 0,
        used: disk[0]?.used || 0,
        free: disk[0]?.available || 0,
        percent: disk[0]?.use || 0,
      },
      uptime: uptime.uptime,
      os: osInfo.platform,
      processes: pm2List_.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// API — SERVICES
// ─────────────────────────────────────────────────────

app.get('/api/services', requireAuth, async (req, res) => {
  try {
    const services = await getServices();
    const pm2Procs = await pm2List().catch(() => []);
    const pm2Map = {};
    pm2Procs.forEach(p => { pm2Map[p.name] = p; });

    const enriched = services.map(svc => {
      const proc = pm2Map[svc.id];
      return {
        ...svc,
        env_vars: undefined,
        pm2: proc ? {
          status: proc.pm2_env?.status,
          uptime: proc.pm2_env?.pm_uptime,
          restarts: proc.pm2_env?.restart_time,
          memory: proc.monit?.memory,
          cpu: proc.monit?.cpu,
          pid: proc.pid,
        } : null,
      };
    });

    res.json({ services: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services', requireAuth, async (req, res) => {
  try {
    const { name, repo_url, branch, pat_key, start_command, path_prefix, port, language, auto_restart, env_vars } = req.body;

    if (!name || !start_command || !path_prefix || !port) {
      return res.status(400).json({ error: 'name, start_command, path_prefix, port are required' });
    }

    const id = uuidv4();
    const dir = path.join(SERVICES_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    await d1.query(
      `INSERT INTO services (id, name, repo_url, branch, pat_key, start_command, path_prefix, port, language, auto_restart, env_vars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, name, repo_url || null, branch || 'main', pat_key || null, start_command, path_prefix, parseInt(port), language || 'node', auto_restart !== false ? 1 : 0, JSON.stringify(env_vars || {})]
    );

    await rebuildProxy();
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/services/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, repo_url, branch, pat_key, start_command, path_prefix, port, language, auto_restart } = req.body;

    await d1.query(
      `UPDATE services SET name=?, repo_url=?, branch=?, pat_key=?, start_command=?, path_prefix=?, port=?, language=?, auto_restart=?, updated_at=datetime('now') WHERE id=?`,
      [name, repo_url || null, branch || 'main', pat_key || null, start_command, path_prefix, parseInt(port), language || 'node', auto_restart !== false ? 1 : 0, id]
    );

    await rebuildProxy();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/services/:id', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    await stopServiceProcess(svc).catch(() => {});
    await d1.query('DELETE FROM services WHERE id = ?', [svc.id]);

    const dir = getServiceDir(svc);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });

    await rebuildProxy();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// API — SERVICE CONTROL
// ─────────────────────────────────────────────────────

app.post('/api/services/:id/start', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    await startServiceProcess(svc);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services/:id/stop', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    await stopServiceProcess(svc);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services/:id/restart', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });
    await pm2Connect();
    await pm2Restart(svc.id).catch(async () => {
      await startServiceProcess(svc);
    });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services/:id/deploy', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const result = await cloneOrPullService(svc);
    if (!result.success) return res.status(400).json({ error: result.message });

    await installDeps(svc).catch(() => {});
    await pm2Connect();
    await pm2Restart(svc.id).catch(async () => {
      await startServiceProcess(svc);
    });

    await d1.query(
      `INSERT INTO deploy_log (service_id, status, message, triggered_by) VALUES (?, 'success', ?, 'manual')`,
      [svc.id, result.message]
    );

    res.json({ success: true, message: result.message });
  } catch (e) {
    await d1.query(
      `INSERT INTO deploy_log (service_id, status, message, triggered_by) VALUES (?, 'failed', ?, 'manual')`,
      [req.params.id, e.message]
    ).catch(() => {});
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/services/:id/deploys', requireAuth, async (req, res) => {
  try {
    const result = await d1.query(
      'SELECT * FROM deploy_log WHERE service_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.params.id]
    );
    res.json({ deploys: result.results || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// API — ENV VARS
// ─────────────────────────────────────────────────────

app.get('/api/services/:id/env', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const stored = JSON.parse(svc.env_vars || '{}');
    const envFile = path.join(getServiceDir(svc), '.env');
    let dotenv = '';
    if (fs.existsSync(envFile)) dotenv = fs.readFileSync(envFile, 'utf-8');

    res.json({ env: stored, dotenv });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services/:id/env', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const { env, dotenv } = req.body;

    if (env) {
      await d1.query('UPDATE services SET env_vars = ?, updated_at = datetime(\'now\') WHERE id = ?', [JSON.stringify(env), svc.id]);
    }

    if (typeof dotenv === 'string') {
      const dir = getServiceDir(svc);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.env'), dotenv);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// API — FILE MANAGER
// ─────────────────────────────────────────────────────

function safeServicePath(svc, filePath) {
  const base = getServiceDir(svc);
  const full = path.resolve(base, filePath.replace(/^\/+/, ''));
  if (!full.startsWith(base)) throw new Error('Path traversal blocked');
  return full;
}

app.get('/api/services/:id/files', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const dirPath = req.query.path ? safeServicePath(svc, req.query.path) : getServiceDir(svc);

    if (!fs.existsSync(dirPath)) return res.json({ files: [] });

    const items = fs.readdirSync(dirPath, { withFileTypes: true })
      .filter(item => item.name !== 'node_modules' && item.name !== '.git')
      .map(item => ({
        name: item.name,
        type: item.isDirectory() ? 'dir' : 'file',
        size: item.isFile() ? fs.statSync(path.join(dirPath, item.name)).size : null,
        path: path.join(req.query.path || '/', item.name),
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ files: items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/services/:id/files/content', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const filePath = safeServicePath(svc, req.query.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'File too large to edit (> 2MB)' });

    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services/:id/files/save', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const filePath = safeServicePath(svc, req.body.path);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, req.body.content);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/services/:id/files/upload', requireAuth, upload.array('files'), async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const uploadPath = req.body.path || '/';
    const dir = safeServicePath(svc, uploadPath);
    fs.mkdirSync(dir, { recursive: true });

    for (const file of req.files) {
      fs.writeFileSync(path.join(dir, file.originalname), file.buffer);
    }

    res.json({ success: true, uploaded: req.files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/services/:id/files', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const filePath = safeServicePath(svc, req.body.path);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Not found' });

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true });
    else fs.unlinkSync(filePath);

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// API — LOGS (SSE)
// ─────────────────────────────────────────────────────

app.get('/api/services/:id/logs', requireAuth, async (req, res) => {
  try {
    const svc = await getService(req.params.id);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const logFile = `/var/log/firekid/${svc.id}.out.log`;
    const errFile = `/var/log/firekid/${svc.id}.err.log`;

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // Send last 100 lines first
    if (fs.existsSync(logFile)) {
      try {
        const lines = fs.readFileSync(logFile, 'utf-8').split('\n').slice(-100);
        lines.forEach(line => line && send({ type: 'out', message: line, time: Date.now() }));
      } catch {}
    }

    // Tail live
    const tail = spawn('tail', ['-f', '-n', '0', logFile], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tailErr = spawn('tail', ['-f', '-n', '0', errFile], { stdio: ['ignore', 'pipe', 'pipe'] });

    tail.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'out', message: line, time: Date.now() })));
    tailErr.stdout.on('data', d => d.toString().split('\n').filter(Boolean).forEach(line => send({ type: 'err', message: line, time: Date.now() })));

    req.on('close', () => {
      tail.kill();
      tailErr.kill();
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// API — GITHUB TOKENS
// ─────────────────────────────────────────────────────

app.get('/api/tokens', requireAuth, async (req, res) => {
  try {
    const tokens = await getTokens();
    res.json({ tokens });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/tokens', requireAuth, async (req, res) => {
  try {
    const { name, token, account, note } = req.body;
    if (!name || !token) return res.status(400).json({ error: 'name and token required' });
    const id = uuidv4();
    await d1.query(
      'INSERT INTO github_tokens (id, name, token, account, note) VALUES (?, ?, ?, ?, ?)',
      [id, name, token, account || null, note || null]
    );
    res.json({ success: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/tokens/:id', requireAuth, async (req, res) => {
  try {
    await d1.query('DELETE FROM github_tokens WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// API — SETTINGS
// ─────────────────────────────────────────────────────

app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const result = await d1.query('SELECT key, value FROM settings');
    const settings = {};
    (result.results || []).forEach(r => { settings[r.key] = r.value; });
    res.json({ settings });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    const { settings } = req.body;
    const stmts = Object.entries(settings).map(([key, value]) => ({
      sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      params: [key, String(value)],
    }));
    await d1.batch(stmts);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// WEBHOOK — auto-deploy on GitHub push
// ─────────────────────────────────────────────────────

app.post('/webhook/:serviceId', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const svc = await getService(req.params.serviceId);
    if (!svc) return res.status(404).json({ error: 'Service not found' });

    const settings = await d1.query('SELECT value FROM settings WHERE key = ?', [`webhook_secret_${svc.id}`]);
    const secret = settings.results?.[0]?.value;

    if (secret) {
      const crypto = require('crypto');
      const sig = req.headers['x-hub-signature-256'];
      const hmac = crypto.createHmac('sha256', secret);
      const digest = 'sha256=' + hmac.update(req.body).digest('hex');
      if (sig !== digest) return res.status(401).json({ error: 'Invalid signature' });
    }

    res.json({ ok: true });

    // Deploy async
    cloneOrPullService(svc)
      .then(() => installDeps(svc).catch(() => {}))
      .then(async () => {
        await pm2Connect();
        await pm2Restart(svc.id).catch(async () => { await startServiceProcess(svc); });
        await d1.query(`INSERT INTO deploy_log (service_id, status, message, triggered_by) VALUES (?, 'success', 'Auto-deployed from webhook', 'webhook')`, [svc.id]);
      })
      .catch(async (e) => {
        await d1.query(`INSERT INTO deploy_log (service_id, status, message, triggered_by) VALUES (?, 'failed', ?, 'webhook')`, [svc.id, e.message]);
      });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────
// WEBSOCKET — terminal per service
// ─────────────────────────────────────────────────────

// Handle upgrade manually so session middleware runs before WS auth check
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  sessionMiddleware(req, {}, () => {
    if (!req.session?.authenticated) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });
});

const terminals = new Map();

wss.on('connection', (ws, req) => {
  const urlParts = req.url.split('/');
  const serviceId = urlParts[urlParts.length - 1]?.split('?')[0];

  let shell;
  let alive = true;

  // Ping every 20s to keep connection open through proxies/CF tunnel
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 20000);

  ws.on('pong', () => { alive = true; });

  (async () => {
    const svc = serviceId !== 'global' ? await getService(serviceId).catch(() => null) : null;
    const cwd = svc ? getServiceDir(svc) : SERVICES_DIR;

    shell = pty.spawn('bash', [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: fs.existsSync(cwd) ? cwd : '/services',
      env: process.env,
    });

    const termId = uuidv4();
    terminals.set(termId, shell);

    shell.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
    });

    shell.on('exit', (code) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'exit', code }));
      terminals.delete(termId);
      clearInterval(pingInterval);
    });

    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg);
        if (parsed.type === 'input') shell.write(parsed.data);
        if (parsed.type === 'resize') shell.resize(parsed.cols, parsed.rows);
      } catch {}
    });

    ws.on('close', () => {
      clearInterval(pingInterval);
      if (shell) shell.kill();
      terminals.delete(termId);
    });

    ws.on('error', (err) => {
      console.error('WS error:', err.message);
      clearInterval(pingInterval);
      if (shell) shell.kill();
      terminals.delete(termId);
    });
  })();
});

// ─────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────

async function startup() {
  fs.mkdirSync(SERVICES_DIR, { recursive: true });
  fs.mkdirSync('/var/log/firekid', { recursive: true });

  console.log('Connecting to pm2...');
  await pm2Connect().catch(err => console.error('pm2 connect error:', err));

  console.log('Loading proxy routes...');
  await rebuildProxy().catch(err => console.error('proxy error:', err));

  console.log('Restoring running services...');
  const services = await getServices().catch(() => []);
  for (const svc of services) {
    if (svc.status === 'running') {
      const dir = getServiceDir(svc);
      if (fs.existsSync(dir)) {
        await startServiceProcess(svc).catch(e => console.error(`Failed to start ${svc.name}:`, e.message));
      }
    }
  }

  server.listen(PORT, () => {
    console.log(`Dashboard running on port ${PORT}`);
  });
}

startup().catch(console.error);

// Catch unhandled errors
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));
