// server.js — TDAConcierge log receiver.
//
// Endpoints:
//   POST /ingest        Cloudflare Worker pushes events here (bearer auth).
//   GET  /api/logs      Query stored events (filters + keyset pagination).
//   GET  /api/stats     Rollup counts for the dashboard header.
//   GET  /api/events    Distinct event names (for the filter dropdown).
//   GET  /api/stream    Server-Sent Events: live tail of new events.
//   GET  /healthz       Liveness probe (used by Docker healthcheck).
//   GET  /              Static dashboard (public/index.html).

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { streamSSE } from "hono/streaming";
import { EventEmitter } from "node:events";
import {
  insertEvents,
  queryEvents,
  statsSummary,
  distinctEvents,
  sessionsSummary,
  pruneOlderThan
} from "./db.js";

const PORT = Number(process.env.PORT || 8080);
const INGEST_TOKEN = process.env.INGEST_TOKEN || "";
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS || 30);
const DASH_USER = process.env.DASH_USER || "";
const DASH_PASS = process.env.DASH_PASS || "";

const bus = new EventEmitter();
bus.setMaxListeners(0); // many SSE clients may subscribe

const app = new Hono();

// Basic Auth guards the dashboard + read APIs once exposed to the internet.
// `/ingest` stays Bearer-token-only (the Worker can't do interactive login) and
// `/healthz` stays open (probes). No-op unless DASH_USER + DASH_PASS are set.
if (DASH_USER && DASH_PASS) {
  const guard = basicAuth({ username: DASH_USER, password: DASH_PASS });
  app.use("*", async (c, next) => {
    const p = c.req.path;
    if (p === "/ingest" || p === "/healthz") return next();
    return guard(c, next);
  });
} else {
  console.log(JSON.stringify({ t: new Date().toISOString(), evt: "warn", msg: "dashboard auth DISABLED (set DASH_USER/DASH_PASS)" }));
}

app.get("/healthz", (c) => c.json({ ok: true, ts: Date.now() }));

// --- ingest ----------------------------------------------------------------
app.post("/ingest", async (c) => {
  if (INGEST_TOKEN) {
    const auth = c.req.header("authorization") || "";
    const tok = auth.startsWith("Bearer ")
      ? auth.slice(7)
      : c.req.header("x-ingest-token") || "";
    if (tok !== INGEST_TOKEN) return c.json({ error: "unauthorized" }, 401);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const arr = Array.isArray(body)
    ? body
    : Array.isArray(body?.events)
      ? body.events
      : [body];
  if (!arr.length) return c.json({ error: "no events" }, 400);

  const stored = insertEvents(arr);
  for (const e of stored) bus.emit("event", e);
  return c.json({ ok: true, count: stored.length });
});

// --- query -----------------------------------------------------------------
app.get("/api/logs", (c) => {
  const q = c.req.query();
  const rows = queryEvents({
    level: q.level,
    event: q.event,
    sid: q.sid,
    source: q.source,
    q: q.q,
    since: q.since ? Number(q.since) : undefined,
    until: q.until ? Number(q.until) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    beforeId: q.before_id ? Number(q.before_id) : undefined
  });
  return c.json({ rows });
});

app.get("/api/stats", (c) => c.json(statsSummary()));
app.get("/api/events", (c) => c.json({ events: distinctEvents() }));
app.get("/api/sessions", (c) => c.json({ sessions: sessionsSummary() }));

// --- live tail (SSE) -------------------------------------------------------
app.get("/api/stream", (c) =>
  streamSSE(c, async (stream) => {
    const queue = [];
    let wake = null;

    const onEvent = (e) => {
      queue.push(e);
      if (wake) { wake(); wake = null; }
    };
    bus.on("event", onEvent);
    stream.onAbort(() => bus.off("event", onEvent));

    await stream.writeSSE({ event: "ready", data: String(Date.now()) });

    while (true) {
      while (queue.length) {
        await stream.writeSSE({ event: "log", data: JSON.stringify(queue.shift()) });
      }
      // Wait for the next event or a 15s heartbeat, whichever comes first.
      await new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, 15000);
      });
      wake = null;
      await stream.writeSSE({ event: "ping", data: String(Date.now()) });
    }
  })
);

// --- static dashboard ------------------------------------------------------
app.use("/*", serveStatic({ root: "./public" }));

// --- retention sweep -------------------------------------------------------
if (RETAIN_DAYS > 0) {
  const sweep = () => {
    try {
      const n = pruneOlderThan(RETAIN_DAYS);
      if (n) console.log(JSON.stringify({ t: new Date().toISOString(), evt: "prune", removed: n }));
    } catch (e) {
      console.error(JSON.stringify({ t: new Date().toISOString(), evt: "prune_fail", msg: e.message }));
    }
  };
  setInterval(sweep, 6 * 3600 * 1000);
  sweep();
}

serve({ fetch: app.fetch, port: PORT }, (info) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), evt: "listening", port: info.port }))
);
