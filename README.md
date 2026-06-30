# TDAConcierge log receiver

Receives event logs from the **tdaconcierge** Cloudflare Worker, stores them in
SQLite, and serves a live dashboard — all running on your NUC in Docker, exposed
over your existing DuckDNS hostname with HTTPS via Caddy.

```
 tdaconcierge Worker ──HTTPS POST /ingest──► wisenerlogs.duckdns.org:9443 ──► NUC (Docker)
   log() forwards each       (Bearer auth)    (router fwd 9443 only)         ├─ caddy (Let's Encrypt via DuckDNS DNS-01 + reverse proxy)
   { t, lvl, evt, ... }                                                      └─ log-receiver (Node + SQLite + dashboard)
```

Cert is issued via the **DuckDNS DNS-01 challenge** (a DuckDNS API token), so
**no port 80 is needed** — only your custom port (`9443`) is forwarded.

The Worker's existing `log()` helper is tapped so **every** structured event it
already emits (`http`, `chat_request`, `chat_response`, `chat_error`, `sync_ok`,
`handover`, client `view_product` / `add_to_cart` / `photo_match` /
`client_error`, …) is forwarded. No new logging call sites were added.

---

## What's in here

```
TDAConcierge-LogReceiver/
├─ docker-compose.yml      caddy (HTTPS) + log-receiver
├─ Caddyfile               reverse proxy + Let's Encrypt via DuckDNS DNS-01
├─ caddy/Dockerfile        Caddy built with the DuckDNS DNS plugin
├─ .env.example            copy to .env and fill in
└─ app/
   ├─ Dockerfile
   ├─ package.json         hono, @hono/node-server (SQLite is Node's built-in node:sqlite)
   ├─ src/
   │  ├─ server.js         /ingest (token), dashboard + APIs (Basic Auth), SSE
   │  └─ db.js             SQLite schema + queries (node:sqlite, Node ≥24)
   └─ public/index.html    dashboard (styled like the Worker's /api/conversations page)
```

Security model:
- **`/ingest`** — Bearer-token only (`INGEST_TOKEN`). Open so the Worker can POST.
- **Dashboard + read APIs** — Basic Auth (`DASH_USER` / `DASH_PASS`).
- **`/healthz`** — open (for probes).

---

## Setup

### 1. Pick secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # INGEST_TOKEN
```
Also choose a dashboard `DASH_USER` / `DASH_PASS`.

### 2. DuckDNS + router

- **Create a dedicated DuckDNS name for logs**, e.g. `wisenerlogs` →
  `wisenerlogs.duckdns.org`, in your DuckDNS account. Keep it **separate** from
  the Home Assistant name so the cert's DNS-01 challenge doesn't clash with the
  HA add-on. Point it at your home IP (simplest: add it to the HA DuckDNS add-on's
  domain list so its IP stays updated).
- Grab your **DuckDNS token** from the DuckDNS account page (same token the HA
  add-on uses).
- On your router, **forward your chosen port (`9443`) to this NUC's LAN IP**.
  No port 80/443 needed — the cert uses the DNS-01 challenge. (HA stays on its
  own port, e.g. 8123 — unaffected.)

### 3. Configure and run on the NUC

```bash
git clone https://github.com/davidwisener-code/TDAConciergeLogReceiver.git
cd TDAConciergeLogReceiver
cp .env.example .env
# edit .env: INGEST_TOKEN, DASH_USER, DASH_PASS, LOG_DOMAIN, LOG_PORT,
#            DUCKDNS_TOKEN, ACME_EMAIL
docker compose up -d --build
```

Watch Caddy obtain the certificate (first boot takes a few seconds):
```bash
docker compose logs -f caddy           # look for "certificate obtained successfully"
docker compose logs -f log-receiver    # expect {"evt":"listening","port":8080}
```

✅ **Checkpoint:** `https://wisenerlogs.duckdns.org:9443/healthz` returns
`{"ok":true,...}` (no login — it's the open probe). Opening
`https://wisenerlogs.duckdns.org:9443/` prompts for the dashboard login.

> LAN shortcut: `http://<nuc-ip>:8080/` also works on your home network (still
> asks for the Basic Auth login).

### 4. Point the Worker at it

In `TDAConcierge-Worker/`:

```bash
# same value as INGEST_TOKEN in .env
npx wrangler secret put LOG_FORWARD_TOKEN

npx wrangler deploy --var LOG_FORWARD_URL:https://wisenerlogs.duckdns.org:9443/ingest
```

Generate some traffic (open the concierge, send a chat) and events appear on the
dashboard within a second. Toggle **Go live** for a real-time tail.

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

Quick manual test (no browser login needed for /ingest):

```bash
curl -X POST https://wisenerlogs.duckdns.org:9443/ingest \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "content-type: application/json" \
  -d '{"t":"2026-06-30T01:00:00Z","lvl":"info","evt":"test","msg":"hello from curl"}'
```

---

## Operations

- **Storage:** SQLite at `./data/logs.db` on the NUC (WAL mode). Survives
  restarts via the `data/` volume.
- **Certs:** persisted in the `caddy_data` Docker volume — don't delete it, or
  Caddy re-requests certs (and may hit Let's Encrypt rate limits).
- **Retention:** events older than `RETAIN_DAYS` (default 30) are swept every 6h.
  Set `RETAIN_DAYS=0` to keep everything.
- **Update:** `git pull && docker compose up -d --build`.
- **Backup:** copy `data/logs.db` (and `-wal`/`-shm` if present) while stopped.

## Notes & trade-offs

- Forwarding is **best-effort** inside `ctx.waitUntil` — if the NUC is down the
  concierge is unaffected and those events are simply not recorded (they still go
  to `wrangler tail` / Workers logs).
- The Worker's `fetch()` requires a **valid** TLS cert — Caddy's Let's Encrypt
  cert satisfies this; a self-signed cert would be rejected.
- Each event is one `fetch` subrequest from the Worker. Volume here is low, so
  this is fine; if it ever grows, batch per request.
