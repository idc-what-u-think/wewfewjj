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

# ── Start dashboard via pm2 ──
echo "[firekid] Starting dashboard on port ${DASHBOARD_PORT:-3000}..."

cat > /tmp/ecosystem.config.js << EOF
module.exports = {
  apps: [{
    name: 'dashboard',
    script: '/dashboard/index.js',
    max_restarts: 20,
    min_uptime: '5s',
    exp_backoff_restart_delay: 200,
    out_file: '/var/log/firekid/dashboard.out.log',
    error_file: '/var/log/firekid/dashboard.err.log',
    merge_logs: true,
    node_args: '--max-old-space-size=512 --expose-gc',
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

echo "[firekid] Dashboard running. Cloudflare tunnel managed by host runner."

# ── Keep container alive + auto-heal ──
while true; do
  sleep 30
  RESP=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:${DASHBOARD_PORT:-3000}/auth/me 2>/dev/null || echo "000")
  if [ "$RESP" != "200" ]; then
    echo "[firekid] Dashboard unhealthy (HTTP $RESP), restarting..."
    tail -20 /var/log/firekid/dashboard.err.log 2>/dev/null || true
    pm2 restart dashboard 2>&1 || pm2 start /tmp/ecosystem.config.js 2>&1
    sleep 5
  fi
done
