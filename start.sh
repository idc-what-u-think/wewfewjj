#!/bin/bash
set -e

echo "[firekid] Starting server..."

# ── Verify required env vars ──
required=(DASHBOARD_USERNAME DASHBOARD_PASSWORD CF_TUNNEL_TOKEN WORKER_URL WORKER_SECRET SESSION_SECRET)
for var in "${required[@]}"; do
  if [ -z "${!var}" ]; then
    echo "[firekid] ERROR: $var is not set"
    exit 1
  fi
done

# ── Start pm2 daemon ──
echo "[firekid] Starting pm2..."
pm2 ping > /dev/null 2>&1 || pm2 start /dashboard/index.js --name dashboard --no-daemon 2>&1 &

# Give pm2 a moment to start
sleep 2

# ── Start dashboard ──
echo "[firekid] Starting dashboard on port ${DASHBOARD_PORT:-3000}..."
pm2 start /dashboard/index.js \
  --name dashboard \
  --env production \
  --max-restarts 5 \
  --min-uptime 5000 \
  --out /var/log/firekid/dashboard.out.log \
  --error /var/log/firekid/dashboard.err.log \
  2>/dev/null || true

# Wait for dashboard to be ready
echo "[firekid] Waiting for dashboard to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:${DASHBOARD_PORT:-3000}/auth/me > /dev/null 2>&1; then
    echo "[firekid] Dashboard is ready"
    break
  fi
  sleep 1
done

# ── Start Cloudflare tunnel ──
echo "[firekid] Starting Cloudflare tunnel..."
cloudflared tunnel --no-autoupdate run --token "${CF_TUNNEL_TOKEN}" &
CF_PID=$!

echo "[firekid] All services started"
echo "[firekid] Dashboard: http://localhost:${DASHBOARD_PORT:-3000}"
echo "[firekid] Public:    https://server.firekidofficial.name.ng"

# ── Keep container alive ──
# Monitor processes and restart if needed
while true; do
  sleep 30

  # Check dashboard is still running
  if ! pm2 list | grep -q "dashboard.*online"; then
    echo "[firekid] Dashboard died, restarting..."
    pm2 restart dashboard 2>/dev/null || pm2 start /dashboard/index.js --name dashboard
  fi

  # Check cloudflared is still running
  if ! kill -0 $CF_PID 2>/dev/null; then
    echo "[firekid] Cloudflare tunnel died, restarting..."
    cloudflared tunnel --no-autoupdate --protocol http2 run --token "${CF_TUNNEL_TOKEN}" &
    CF_PID=$!
  fi
done
