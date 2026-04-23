FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV SERVICES_DIR=/services
ENV DASHBOARD_PORT=3000

# ── Base packages ──
RUN apt-get update && apt-get install -y \
    curl wget git \
    python3 python3-pip \
    unzip tar ca-certificates \
    lsof procps net-tools \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# ── Bun ──
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# ── PM2 + node-gyp ──
RUN npm install -g pm2 node-gyp

# ── Setup directories ──
RUN mkdir -p /services /var/log/firekid /dashboard

# ── Install dashboard deps ──
COPY dashboard/package.json /dashboard/
RUN cd /dashboard && npm install --production=false

# ── Rebuild native modules ──
RUN cd /dashboard && npm rebuild node-pty && echo "node-pty OK"

# ── Verify critical deps ──
RUN node -e "require('/dashboard/node_modules/node-pty'); console.log('node-pty OK')"
RUN node -e "require('/dashboard/node_modules/express'); console.log('express OK')"
RUN node -e "require('/dashboard/node_modules/ws'); console.log('ws OK')"

# ── Copy dashboard source ──
COPY dashboard/ /dashboard/

# ── Copy start script ──
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 3000

CMD ["/start.sh"]
