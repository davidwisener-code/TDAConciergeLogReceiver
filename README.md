# TDAConcierge log receiver

Receives event logs from the **tdaconcierge** Cloudflare Worker, stores them in
SQLite, and serves a live dashboard — all running on your NUC in Docker.

```
 tdaconcierge Worker ──HTTPS POST /ingest──► Cloudflare Tunnel ──► NUC (Docker)
   log() forwards each       (Bearer auth)      logs.yourdomain.com    ├─ log-receiver (Node + SQLite + dashboard)
   { t, lvl, evt, ... }                                               └─ cloudflared (tunnel connector)
```

The Worker's existing `log()` helper is tapped so **every** structured event it
already emits (`http`, `chat_request`, `chat_response`, `chat_error`, `sync_ok`,
`handover`, client `view_product` / `add_to_cart` / `photo_match` /
`client_error`, …) is forwarded. No new logging call sites were added.

---

## What's in here

```
TDAConcierge-LogReceiver/
├─ docker-compose.yml      log-receiver + cloudflared
├─ .env.example            copy to .env and fill in
└─ app/
   ├─ Dockerfile
   ├─ package.json         hono, @hono/node-server (SQLite is Node's built-in node:sqlite)
   ├─ src/
   │  ├─ server.js         /ingest, /api/logs, /api/stats, /api/stream (SSE), static
   │  └─ db.js             SQLite schema + queries (node:sqlite, Node ≥24)
   └─ public/index.html    dashboard (styled like the Worker's /api/conversations page)
```

---

## Setup

### 1. Pick a hostname and a secret

- Hostname: e.g. `logs.yourdomain.com` (must be on a domain in your Cloudflare account).
- Ingest secret: generate one and keep it handy —
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```

### 2. Create the Cloudflare Tunnel

In the Cloudflare dashboard → **Zero Trust → Networks → Tunnels**:

1. **Create a tunnel** (Cloudflared type). Name it e.g. `nuc-logs`.
2. On the **Install connector** screen, copy the **tunnel token** (the long
   `eyJ…` string). You do *not* run the install command it shows — `cloudflared`
   runs in Docker here and reads the token from `.env`.
3. Add a **Public Hostname**:
   - Subdomain/domain: `logs` / `yourdomain.com`
   - Service: **HTTP** → `log-receiver:8080`
     (that's the compose service name + port, reachable inside the Docker network)

### 3. Configure and run on the NUC

```bash
cd TDAConcierge-LogReceiver
cp .env.example .env
# edit .env: INGEST_TOKEN=<the secret>, TUNNEL_TOKEN=<the eyJ… token>
docker compose up -d --build
```

Check it's healthy:

```bash
docker compose ps
docker compose logs -f log-receiver     # expect {"evt":"listening","port":8080}
curl -fsS https://logs.yourdomain.com/healthz   # {"ok":true,...}
```

Dashboard: **https://logs.yourdomain.com/** (or `http://<nuc-ip>:8080/` on your LAN).

> The dashboard and ingest endpoint share the same hostname. `/ingest` requires
> the bearer token; the dashboard pages are open to anyone who can reach the
> hostname. If you want the dashboard private too, put it behind a Cloudflare
> Access policy on `logs.yourdomain.com` (allow your email) and exclude the
> `/ingest` path, or restrict it to your LAN only by not adding a public
> hostname for the dashboard paths.

### 4. Point the Worker at it

In `TDAConcierge-Worker/`:

```bash
# 1. set the destination (uncomment + edit LOG_FORWARD_URL in wrangler.toml, or)
npx wrangler deploy --var LOG_FORWARD_URL:https://logs.yourdomain.com/ingest

# 2. set the matching secret (same value as INGEST_TOKEN in .env)
npx wrangler secret put LOG_FORWARD_TOKEN

# 3. deploy
npx wrangler deploy
```

Generate some traffic (open the concierge, send a chat) and events should appear
on the dashboard within a second. Toggle **Go live** for a real-time tail.

---

## Ingest contract

`POST /ingest` with `Authorization: Bearer <INGEST_TOKEN>`.

Body is either a single event object or an array of them. The receiver stores
the full JSON verbatim and promotes common fields to columns for fast filtering.
It accepts the Worker's native shape:

```json
{ "t": "2026-06-30T01:23:45.678Z", "lvl": "info", "evt": "http",
  "reqId": "a1b2c3", "method": "POST", "path": "/api/chat", "status": 200, "ms": 412 }
```

`t`→time, `lvl`→level, `evt`→event; `reqId`, `sid`, `path`, `status`, `ms`,
`msg` are indexed. KV-style `{ at, kind, action, … }` entries are accepted too.

Quick manual test:

```bash
curl -X POST https://logs.yourdomain.com/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "content-type: application/json" \
  -d '{"t":"2026-06-30T01:00:00Z","lvl":"info","evt":"test","msg":"hello from curl"}'
```

---

## Operations

- **Storage:** SQLite at `./data/logs.db` on the NUC (WAL mode). Survives
  restarts via the `data/` volume.
- **Retention:** events older than `RETAIN_DAYS` (default 30) are swept every 6h.
  Set `RETAIN_DAYS=0` to keep everything.
- **Update:** `docker compose up -d --build` after pulling changes.
- **Backup:** copy `data/logs.db` (and `-wal`/`-shm` if present) while the
  container is stopped, or use `sqlite3 data/logs.db ".backup backup.db"`.

## Notes & trade-offs

- Forwarding is **best-effort** inside `ctx.waitUntil` — if the NUC/tunnel is
  down the concierge is unaffected and those events are simply not recorded
  (they still go to `wrangler tail` / Workers logs).
- Each event is one `fetch` subrequest from the Worker. Volume here is low
  (a shoe-care chatbot), so this is fine; if it ever grows, batch per request.
- `photo_match` events can carry a base64 thumbnail (~up to 80 KB) — these are
  stored as-is in the event JSON.
