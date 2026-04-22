FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV SERVICES_DIR=/services
ENV DASHBOARD_PORT=3000

# ── Base packages ──
RUN apt-get update && apt-get install -y \
    curl wget git build-essential \
    python3 python3-pip python3-venv \
    unzip tar ca-certificates \
    lsof procps net-tools \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 20 ──
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── Bun ──
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# ── Go ──
RUN wget -q https://go.dev/dl/go1.22.0.linux-amd64.tar.gz \
    && tar -C /usr/local -xzf go1.22.0.linux-amd64.tar.gz \
    && rm go1.22.0.linux-amd64.tar.gz
ENV PATH=$PATH:/usr/local/go/bin

# ── Deno ──
RUN curl -fsSL https://deno.land/install.sh | sh \
    && ln -s /root/.deno/bin/deno /usr/local/bin/deno

# ── pm2 ──
RUN npm install -g pm2

# ── cloudflared ──
RUN wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb \
    && dpkg -i cloudflared-linux-amd64.deb \
    && rm cloudflared-linux-amd64.deb

# ── node-pty deps (needs python + make + g++) ──
RUN npm install -g node-gyp

# ── Setup directories ──
RUN mkdir -p /services /var/log/firekid /dashboard

# ── Install dashboard deps ──
COPY dashboard/package.json /dashboard/
RUN cd /dashboard && npm install

# ── Copy dashboard source ──
COPY dashboard/ /dashboard/

# ── Copy start script ──
COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 3000

CMD ["/start.sh"]
