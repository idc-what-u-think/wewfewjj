# firekid-server

GitHub Actions as a free server. Runs a Docker container with a full dashboard, terminal, file manager, and auto-deploy via webhook.

---

## Setup Order

### 1. Deploy the Worker (firekid-worker repo)

```bash
cd firekid-worker

# Install wrangler
npm install

# Edit wrangler.toml — fill in your KV namespace ID and D1 database ID

# Set the worker secret
npm run secret

# Deploy
npm run deploy

# Initialize the D1 schema (run once)
curl -X POST https://your-worker.workers.dev/init \
  -H "X-Worker-Secret: YOUR_SECRET"
```

---

### 2. Set GitHub Secrets (firekid-server repo)

Go to your repo → Settings → Secrets → Actions → New repository secret:

| Secret | Value |
|---|---|
| `DASHBOARD_USERNAME` | Your login username |
| `DASHBOARD_PASSWORD` | Your login password |
| `CF_TUNNEL_TOKEN` | From Cloudflare Zero Trust → Tunnels |
| `WORKER_URL` | Your deployed worker URL (https://...) |
| `WORKER_SECRET` | Same secret you set with `wrangler secret put` |
| `SESSION_SECRET` | Any random 32+ char string |
| `GH_PAT` | PAT from the account owning THIS repo (needs `actions:write`) |

---

### 3. Set Up Cloudflare Tunnel

1. Go to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → Networks → Tunnels
2. Create tunnel → Name: `firekid-server`
3. Copy the tunnel token → save as `CF_TUNNEL_TOKEN` secret
4. Add public hostname:
   - Subdomain: `server`
   - Domain: `firekidofficial.name.ng`
   - Service: `http://localhost:3000`

---

### 4. Run the Action

Go to your repo → Actions → Firekid Server → Run workflow

The server will be live at `https://server.firekidofficial.name.ng`

---

## Adding Services

1. Open the dashboard
2. Click "Add Service"
3. Fill in:
   - Name: anything
   - Repo URL: your private or public repo
   - Branch: main
   - GitHub Token: select one you added in the Tokens page
   - Start Command: `node index.js` / `python main.py` / etc.
   - URL Path: `/my-service` (accessible at `server.firekidofficial.name.ng/my-service/`)
   - Port: any available port (3001, 3002, etc.)

---

## Auto-Deploy Webhook

For each service, go to its GitHub repo → Settings → Webhooks:

- Payload URL: `https://server.firekidofficial.name.ng/webhook/SERVICE_ID`
- Content type: `application/json`
- Events: Just the push event

Push code → server auto-deploys → bot restarts in ~2s.

---

## Supported Languages

| Language | Install | Start command example |
|---|---|---|
| Node.js | `npm install` | `node index.js` |
| Bun | `bun install` | `bun run index.ts` |
| Python | `pip install -r requirements.txt` | `python main.py` |
| Go | `go mod download` | `go run main.go` |
| Deno | none | `deno run --allow-all main.ts` |
