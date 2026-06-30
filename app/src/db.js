// db.js — SQLite storage for incoming TDAConcierge events.
//
// Uses Node's built-in node:sqlite (stable since Node 24) — no native build
// step. One table, `events`, holds every log line the Worker forwards. The full
// original JSON is kept verbatim in `data`; a handful of common fields are
// promoted to real columns so the dashboard can filter/sort fast without
// parsing JSON on every row.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH || "/data/logs.db";
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,        -- event time, epoch ms (from "t")
    received_at INTEGER NOT NULL,        -- when we ingested it, epoch ms
    level       TEXT,                    -- "info" | "error" (from "lvl")
    event       TEXT,                    -- event name (from "evt"/"kind")
    source      TEXT,                    -- origin, default "tdaconcierge"
    req_id      TEXT,
    sid         TEXT,
    path        TEXT,
    status      INTEGER,
    ms          REAL,
    msg         TEXT,
    data        TEXT NOT NULL            -- full original JSON
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts     ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_event  ON events(event);
  CREATE INDEX IF NOT EXISTS idx_events_level  ON events(level);
  CREATE INDEX IF NOT EXISTS idx_events_sid    ON events(sid);
`);

function safeParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

// Coerce a timestamp (ISO string, epoch ms, or epoch s) into epoch ms.
function toTs(t, fallback) {
  if (typeof t === "number" && Number.isFinite(t)) {
    return t < 1e12 ? Math.round(t * 1000) : Math.round(t); // seconds → ms
  }
  if (typeof t === "string") {
    const d = Date.parse(t);
    if (!Number.isNaN(d)) return d;
  }
  return fallback;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

const insertStmt = db.prepare(`
  INSERT INTO events (ts, received_at, level, event, source, req_id, sid, path, status, ms, msg, data)
  VALUES (@ts, @received_at, @level, @event, @source, @req_id, @sid, @path, @status, @ms, @msg, @data)
`);

// Normalise one raw event object into a stored row. Accepts the Worker's
// `{ t, lvl, evt, ... }` shape as well as KV-style `{ at, kind, ... }` entries.
function normalise(raw, now) {
  const o = raw && typeof raw === "object" ? raw : { msg: String(raw) };
  const rec = {
    ts: toTs(o.t ?? o.ts ?? o.at, now),
    received_at: now,
    level: String(o.lvl ?? o.level ?? "info").slice(0, 16),
    event: o.evt ?? o.event ?? o.kind ?? o.action ?? null,
    source: o.source ?? o.src ?? "tdaconcierge",
    req_id: o.reqId ?? o.req_id ?? null,
    sid: o.sid ?? o.sessionId ?? null,
    path: o.path ?? o.url ?? null,
    status: num(o.status),
    ms: num(o.ms),
    msg: o.msg ?? o.message ?? null,
    data: JSON.stringify(o)
  };
  // node:sqlite binds strings/numbers/null only — coerce and bound the columns.
  for (const k of ["event", "source", "req_id", "sid", "path", "msg"]) {
    rec[k] = rec[k] == null ? null : String(rec[k]).slice(0, 512);
  }
  return rec;
}

// Insert a batch atomically. Returns the stored rows (with numeric id and the
// parsed `data` object) so the caller can broadcast them to live listeners.
export function insertEvents(arr, now = Date.now()) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const out = [];
  db.exec("BEGIN");
  try {
    for (const raw of arr) {
      const rec = normalise(raw, now);
      const info = insertStmt.run(rec);
      out.push({ id: Number(info.lastInsertRowid), ...rec, data: safeParse(rec.data) });
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return out;
}

export function queryEvents(f = {}) {
  const where = [];
  const p = {};
  if (f.level)  { where.push("level = @level");   p.level = f.level; }
  if (f.event)  { where.push("event = @event");   p.event = f.event; }
  if (f.sid)    { where.push("sid = @sid");       p.sid = f.sid; }
  if (f.source) { where.push("source = @source"); p.source = f.source; }
  if (f.since)  { where.push("ts >= @since");     p.since = f.since; }
  if (f.until)  { where.push("ts <= @until");     p.until = f.until; }
  if (f.q) {
    where.push("(msg LIKE @q OR event LIKE @q OR sid LIKE @q OR path LIKE @q OR data LIKE @q)");
    p.q = "%" + f.q + "%";
  }
  if (f.beforeId) { where.push("id < @beforeId"); p.beforeId = f.beforeId; }

  p.limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
  const sql =
    `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ` +
    `ORDER BY id DESC LIMIT @limit`;
  return db.prepare(sql).all(p).map((r) => ({ ...r, data: safeParse(r.data) }));
}

export function statsSummary() {
  const since = Date.now() - 24 * 3600 * 1000;
  const total = db.prepare("SELECT COUNT(*) n FROM events").get().n;
  const last24 = db.prepare("SELECT COUNT(*) n FROM events WHERE ts >= @s").get({ s: since }).n;
  const errors24 = db
    .prepare("SELECT COUNT(*) n FROM events WHERE ts >= @s AND level = 'error'")
    .get({ s: since }).n;
  const byEvent = db
    .prepare("SELECT event, COUNT(*) n FROM events WHERE ts >= @s GROUP BY event ORDER BY n DESC LIMIT 12")
    .all({ s: since });
  const newest = db.prepare("SELECT ts FROM events ORDER BY id DESC LIMIT 1").get();
  return { total: Number(total), last24: Number(last24), errors24: Number(errors24), byEvent, newestTs: newest ? newest.ts : null };
}

export function distinctEvents() {
  return db
    .prepare("SELECT DISTINCT event FROM events WHERE event IS NOT NULL ORDER BY event")
    .all()
    .map((r) => r.event);
}

// One row per session (sid): event count, first/last time, and the most recent
// chat question (pulled from the chat_request event's JSON) as a preview.
export function sessionsSummary(limit = 200) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const sql = `
    SELECT s.sid AS sid, s.n AS n, s.lastTs AS lastTs, s.firstTs AS firstTs,
      (SELECT json_extract(data, '$.q') FROM events e
         WHERE e.sid = s.sid AND e.event = 'chat_request'
           AND json_extract(data, '$.q') IS NOT NULL
         ORDER BY ts DESC LIMIT 1) AS lastQ
    FROM (
      SELECT sid, COUNT(*) AS n, MAX(ts) AS lastTs, MIN(ts) AS firstTs
      FROM events WHERE sid IS NOT NULL AND sid != '' GROUP BY sid
    ) s
    ORDER BY s.lastTs DESC
    LIMIT @limit`;
  return db.prepare(sql).all({ limit: lim });
}

export function pruneOlderThan(days) {
  if (!days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400 * 1000;
  return Number(db.prepare("DELETE FROM events WHERE ts < @c").run({ c: cutoff }).changes);
}
