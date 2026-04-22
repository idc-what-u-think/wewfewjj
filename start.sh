#!/bin/bash
set -e

echo "================================================================"
echo "[firekid] Container starting..."
echo "[firekid] Date: $(date)"
echo "[firekid] Node: $(node --version)"
echo "[firekid] npm:  $(npm --version)"
echo "================================================================"

# ── Verify required env vars ──
echo "[firekid] Checking env vars..."
required=(DASHBOARD_USERNAME DASHBOARD_PASSWORD WORKER_URL WORKER_SECRET SESSION_SECRET)
for var in "${required[@]}"; do
  if [ -z "${!var}" ]; then
    echo "[firekid] ERROR: $var is not set"
    exit 1
  fi
  echo "[firekid]   $var = SET"
done

# ── Check node_modules ──
echo "[firekid] Checking node_modules..."
if [ ! -d "/dashboard/node_modules" ]; then
  echo "[firekid] node_modules missing, running npm install..."
  cd /dashboard && npm install 2>&1
fi

# ── Rebuild native modules ──
echo "[firekid] Rebuilding native modules..."
cd /dashboard && npm rebuild node-pty 2>&1 && echo "[firekid] node-pty OK"

# ── Test deps ──
echo "[firekid] Testing dependencies..."
deps=(express ws express-session cookie-parser multer pm2 axios systeminformation uuid simple-git)
for dep in "${deps[@]}"; do
  node -e "require('$dep'); console.log('[firekid]   $dep OK')" 2>&1 || echo "[firekid]   $dep FAILED"
done

# ── Dry run test ──
echo "[firekid] Dry-run test..."
timeout 5 node /dashboard/index.js 2>&1 &
TESTPID=$!
sleep 4
if kill -0 $TESTPID 2>/dev/null; then
  echo "[firekid] Dry-run passed"
  kill $TESTPID 2>/dev/null || true
  wait $TESTPID 2>/dev/null || true
else
  echo "[firekid] WARNING: Dashboard exited during dry-run"
fi

# ── Start dashboard via pm2 ecosystem file ──
echo "[firekid] Starting dashboard on port ${DASHBOARD_PORT:-3000}..."

cat > /tmp/ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'dashboard',
    script: '/dashboard/index.js',
    max_restarts: 10,
    out_file: '/var/log/firekid/dashboard.out.log',
    error_file: '/var/log/firekid/dashboard.err.log',
    merge_logs: true,
    env: {
      DASHBOARD_PORT: process.env.DASHBOARD_PORT || '3000',
      DASHBOARD_USERNAME: process.env.DASHBOARD_USERNAME,
      DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD,
      WORKER_URL: process.env.WORKER_URL,
      WORKER_SECRET: process.env.WORKER_SECRET,
      SESSION_SECRET: process.env.SESSION_SECRET,
      GH_PAT: process.env.GH_PAT,
      SERVICES_DIR: process.env.SERVICES_DIR || '/services',
    }
  }]
}
EOF

pm2 start /tmp/ecosystem.config.js 2>&1
sleep 3
pm2 list 2>&1

# ── Wait for HTTP response ──
echo "[firekid] Waiting for dashboard HTTP response..."
READY=0
for i in $(seq 1 30); do
  RESP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${DASHBOARD_PORT:-3000}/auth/me 2>/dev/null || echo "000")
  echo "[firekid]   Attempt $i: HTTP $RESP"
  if [ "$RESP" = "200" ]; then
    echo "[firekid] Dashboard is ready"
    READY=1
    break
  fi
  sleep 2
done

if [ "$READY" = "0" ]; then
  echo "[firekid] Dashboard never became ready. Dumping logs:"
  cat /var/log/firekid/dashboard.err.log 2>/dev/null || echo "(no error log)"
  cat /var/log/firekid/dashboard.out.log 2>/dev/null || echo "(no stdout log)"
fi

echo "[firekid] Dashboard running. Cloudflare tunnel is managed by the host runner."

# ── Keep container alive ──
while true; do
  sleep 30
  RESP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${DASHBOARD_PORT:-3000}/auth/me 2>/dev/null || echo "000")
  if [ "$RESP" != "200" ]; then
    echo "[firekid] Dashboard unhealthy (HTTP $RESP), restarting..."
    tail -10 /var/log/firekid/dashboard.err.log 2>/dev/null || true
    pm2 restart dashboard 2>&1 || pm2 start /dashboard/index.js --name dashboard 2>&1
    sleep 5
  fi
done
