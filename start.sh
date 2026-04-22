#!/bin/bash
set -e

echo "================================================================"
echo "[firekid] Container starting..."
echo "[firekid] Date: $(date)"
echo "[firekid] Node: $(node --version)"
echo "[firekid] npm:  $(npm --version)"
echo "[firekid] OS:   $(uname -a)"
echo "================================================================"

# ── Verify required env vars ──
echo "[firekid] Checking env vars..."
required=(DASHBOARD_USERNAME DASHBOARD_PASSWORD CF_TUNNEL_TOKEN WORKER_URL WORKER_SECRET SESSION_SECRET)
for var in "${required[@]}"; do
  if [ -z "${!var}" ]; then
    echo "[firekid] ERROR: $var is not set"
    exit 1
  fi
  echo "[firekid]   $var = SET"
done

# ── Check node_modules ──
echo ""
echo "[firekid] Checking node_modules..."
if [ ! -d "/dashboard/node_modules" ]; then
  echo "[firekid] ERROR: node_modules missing! Running npm install..."
  cd /dashboard && npm install 2>&1
else
  echo "[firekid] node_modules exists"
  echo "[firekid] Packages installed: $(ls /dashboard/node_modules | wc -l)"
fi

# ── Check node-pty specifically (native module, most likely to fail) ──
echo ""
echo "[firekid] Testing node-pty (native module)..."
node -e "require('node-pty'); console.log('[firekid] node-pty OK')" 2>&1 || {
  echo "[firekid] node-pty FAILED. Rebuilding..."
  cd /dashboard && npm rebuild node-pty 2>&1
  node -e "require('node-pty'); console.log('[firekid] node-pty OK after rebuild')" 2>&1 || echo "[firekid] node-pty still failing"
}

# ── Test each critical dependency ──
echo ""
echo "[firekid] Testing critical dependencies..."
deps=(express ws express-session cookie-parser multer pm2 axios systeminformation uuid simple-git)
for dep in "${deps[@]}"; do
  node -e "require('$dep'); console.log('[firekid]   $dep OK')" 2>&1 || echo "[firekid]   $dep FAILED"
done

# ── Dry run dashboard (5 second test) ──
echo ""
echo "[firekid] Dry-run test of dashboard/index.js..."
timeout 5 node /dashboard/index.js 2>&1 &
TESTPID=$!
sleep 4
if kill -0 $TESTPID 2>/dev/null; then
  echo "[firekid] Dashboard started successfully in dry-run"
  kill $TESTPID 2>/dev/null || true
  wait $TESTPID 2>/dev/null || true
else
  echo "[firekid] Dashboard exited during dry-run (check errors above)"
fi

# ── Start pm2 daemon ──
echo ""
echo "[firekid] Starting pm2 daemon..."
pm2 ping 2>&1 || true
sleep 1

# ── Start dashboard via pm2 ──
echo "[firekid] Starting dashboard on port ${DASHBOARD_PORT:-3000}..."
pm2 start /dashboard/index.js \
  --name dashboard \
  --max-restarts 10 \
  --min-uptime 3000 \
  --out /var/log/firekid/dashboard.out.log \
  --error /var/log/firekid/dashboard.err.log \
  2>&1

sleep 3
echo "[firekid] pm2 status:"
pm2 list 2>&1

# ── Wait for dashboard to be ready ──
echo ""
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
  echo ""
  echo "[firekid] Dashboard never became ready. Dumping logs:"
  echo "--- STDOUT ---"
  cat /var/log/firekid/dashboard.out.log 2>/dev/null || echo "(empty)"
  echo "--- STDERR ---"
  cat /var/log/firekid/dashboard.err.log 2>/dev/null || echo "(empty)"
  echo "--- PM2 logs ---"
  pm2 logs dashboard --lines 30 --nostream 2>&1 || true
fi

# ── Start Cloudflare tunnel ──
echo ""
echo "[firekid] Starting Cloudflare tunnel (http2 protocol)..."
cloudflared tunnel --no-autoupdate --protocol http2 run --token "${CF_TUNNEL_TOKEN}" 2>&1 &
CF_PID=$!

echo "[firekid] All services started"
echo "[firekid] Dashboard: http://localhost:${DASHBOARD_PORT:-3000}"
echo "[firekid] Public:    https://server.firekidofficial.name.ng"

# ── Keep container alive ──
CRASH_COUNT=0
while true; do
  sleep 30

  # Check dashboard
  RESP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${DASHBOARD_PORT:-3000}/auth/me 2>/dev/null || echo "000")
  if [ "$RESP" != "200" ]; then
    CRASH_COUNT=$((CRASH_COUNT + 1))
    echo "[firekid] Dashboard unhealthy (HTTP $RESP) - crash #$CRASH_COUNT. Restarting..."
    echo "--- Recent error log ---"
    tail -20 /var/log/firekid/dashboard.err.log 2>/dev/null || true
    echo "--- Recent stdout log ---"
    tail -10 /var/log/firekid/dashboard.out.log 2>/dev/null || true
    pm2 restart dashboard 2>&1 || pm2 start /dashboard/index.js --name dashboard 2>&1
    sleep 5
  fi

  # Check cloudflared
  if ! kill -0 $CF_PID 2>/dev/null; then
    echo "[firekid] Cloudflare tunnel died, restarting..."
    cloudflared tunnel --no-autoupdate --protocol http2 run --token "${CF_TUNNEL_TOKEN}" 2>&1 &
    CF_PID=$!
  fi
done
