// /api/cron.js
import { kv } from "@vercel/kv";

import universe from "./universe.js";
import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";

import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// ================== CONSTANTS ==================
const CRON_LOCK_KEY = "lock:cron";
// kort houden zodat het nooit “vast” blijft hangen
const CRON_LOCK_TTL_SEC = 6 * 60;

// heartbeat: UI/diagnose ziet dat cron leeft
const CRON_HEARTBEAT_KEY = "cron:last";
const CRON_HEARTBEAT_TTL_SEC = 6 * 60 * 60;

// --------------------
// mini-res object dat ALLE stijlen aankan
// --------------------
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = String(v);
    },
    status(code) {
      this.statusCode = Number(code) || 200;
      return this;
    },
    json(obj) {
      this.setHeader("content-type", "application/json; charset=utf-8");
      this.end(JSON.stringify(obj));
      return this;
    },
    end(txt) {
      this.body = String(txt || "");
    },
  };
}

function safeJson(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return { ok: false, raw: String(txt || "") };
  }
}

function q(req, key, def) {
  const v = req?.query?.[key];
  if (v === undefined || v === null || v === "") return def;
  return String(v);
}

function normMode(raw) {
  const m = String(raw || "").toLowerCase().trim();
  if (m === "bull" || m === "bear") return m;
  if (m === "both" || m === "all") return "both";
  return "both";
}

function pickSecret() {
  return (
    process.env.CC_SECRET ||
    process.env.SECRET ||
    process.env.API_SECRET ||
    process.env.CRON_SECRET ||
    ""
  );
}

function makeInternalReq({ path, mode, max, radar, symbols, secret }) {
  const query = {};
  if (mode !== undefined) query.mode = String(mode);
  if (max !== undefined) query.max = String(max);
  if (radar !== undefined) query.radar = String(radar);
  if (symbols) query.symbols = String(symbols);
  if (secret) query.secret = String(secret);

  const qs = Object.keys(query)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");

  const url = `${String(path)}${qs ? `?${qs}` : ""}`;

  const headers = {};
  if (secret) {
    headers["x-api-key"] = String(secret);
    headers["authorization"] = `Bearer ${secret}`;
  }

  return { method: "GET", query, headers, url };
}

function assertOkSoft(name, parsed, resObj) {
  if (parsed?.ok === false) {
    return {
      ok: false,
      error: `${name} returned ok:false (status ${resObj?.statusCode || "?"}) :: ${
        parsed?.error || parsed?.raw || "unknown"
      }`,
    };
  }
  if (parsed?.error) return { ok: false, error: `${name} error :: ${parsed.error}` };
  return { ok: true };
}

// --------------------
// KV lock (stale-safe)
// --------------------
async function acquireLock() {
  const now = Date.now();
  const until = now + CRON_LOCK_TTL_SEC * 1000;

  const ok = await kv.set(
    CRON_LOCK_KEY,
    { until, setAt: now },
    { nx: true, ex: CRON_LOCK_TTL_SEC }
  );

  if (ok) return { ok: true, until, waitMs: 0 };

  const cur = await kv.get(CRON_LOCK_KEY);
  const curUntil = Number(cur?.until || 0);

  // stale -> overnemen
  if (curUntil > 0 && curUntil < now) {
    await kv.set(CRON_LOCK_KEY, { until, setAt: now }, { ex: CRON_LOCK_TTL_SEC });
    return { ok: true, until, waitMs: 0 };
  }

  return {
    ok: false,
    until: curUntil || null,
    waitMs: curUntil > now ? curUntil - now : null,
  };
}

async function releaseLock() {
  try {
    await kv.del(CRON_LOCK_KEY);
  } catch {}
}

function isVercelCron(req) {
  const h = req?.headers || {};
  const v =
    h["x-vercel-cron"] ||
    h["x-vercel-cron-job"] ||
    h["X-Vercel-Cron"] ||
    h["X-Vercel-Cron-Job"];
  return String(v || "") !== "";
}

async function runOneMode(mode, max, radar, symbols, secret) {
  const reqMap = makeInternalReq({ path: "/api/ob/map_refresh", mode, secret });

  // sampler met from=map
  const reqOb = makeInternalReq({ path: "/api/ob/sampler", mode, secret });
  reqOb.query.from = "map";
  reqOb.query.limit = "80";

  // url opnieuw bouwen
  const qs = Object.keys(reqOb.query)
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(reqOb.query[k])}`)
    .join("&");
  reqOb.url = `/api/ob/sampler?${qs}`;

  const reqScan = makeInternalReq({ path: "/api/scan", mode, max, radar, secret });

  // 1) map_refresh
  const resMap = makeRes();
  await obMapRefresh(reqMap, resMap);
  const mapOut = safeJson(resMap.body);
  const a1 = assertOkSoft(`obMapRefresh(${mode})`, mapOut, resMap);

  // 2) sampler
  const resOb = makeRes();
  await obSampler(reqOb, resOb);
  const obOut = safeJson(resOb.body);
  const a2 = assertOkSoft(`obSampler(${mode})`, obOut, resOb);

  // 3) scan
  const resScan = makeRes();
  await scan(reqScan, resScan);
  const scanOut = safeJson(resScan.body);
  const a3 = assertOkSoft(`scan(${mode})`, scanOut, resScan);

  const ok = a1.ok && a2.ok && a3.ok;
  const errors = [a1, a2, a3].filter((x) => !x.ok).map((x) => x.error);

  // Discord-berichten via cron zijn uitgeschakeld; routing loopt alleen via sendSignal() in scan.js / moon/scan.js
  const discord = { ok: true, skipped: true, why: "cron discord disabled" };

  return { ok, mode, errors, obMap: mapOut, ob: obOut, scan: scanOut, discord };
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  let gotLock = false;

  try {
    // Vercel Cron = toegestaan
    if (!isVercelCron(req)) {
      // Handmatig testen → secret verplicht
      if (!requireSecret(req, res)) return;
    }

    const cronLock = await acquireLock();
    gotLock = !!cronLock.ok;

    if (!gotLock) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(
        JSON.stringify({
          ok: true,
          skipped: true,
          reason: "cron already running (lock active)",
          ts: Date.now(),
          lock: { key: CRON_LOCK_KEY, until: cronLock.until, waitMs: cronLock.waitMs },
        })
      );
    }

    // eerst query secret, dan ENV secret
    const secretFromQuery = String(req?.query?.secret || "").trim();
    const secret = secretFromQuery || pickSecret();

    // ✅ 0) universe 1x per cron-run (heeft eigen 30m lock)
    const reqUni = makeInternalReq({ path: "/api/universe", secret });
    const resUni = makeRes();
    await universe(reqUni, resUni);
    const uniOut = safeJson(resUni.body);
    const uniAssert = assertOkSoft("universe()", uniOut, resUni);

    const mode = normMode(req?.query?.mode);
    const max = q(req, "max", "60");
    const radar = q(req, "radar", "200");
    const symbols = q(req, "symbols", "PEPE,SONIC,TURBO");

    let out = null;

    if (mode === "both") {
      const [bullRes, bearRes] = await Promise.allSettled([
        runOneMode("bull", max, radar, symbols, secret),
        runOneMode("bear", max, radar, symbols, secret),
      ]);

      const bull =
        bullRes.status === "fulfilled"
          ? bullRes.value
          : { ok: false, errors: [String(bullRes.reason?.message || bullRes.reason || "bull failed")] };

      const bear =
        bearRes.status === "fulfilled"
          ? bearRes.value
          : { ok: false, errors: [String(bearRes.reason?.message || bearRes.reason || "bear failed")] };

      out = {
        ok: uniAssert.ok && !!bull.ok && !!bear.ok,
        ts: Date.now(),
        mode: "both",
        params: { max, radar, symbols },
        universe: uniOut,
        bull,
        bear,
      };
    } else {
      const one = await runOneMode(mode, max, radar, symbols, secret);
      out = {
        ok: uniAssert.ok && !!one.ok,
        ts: Date.now(),
        mode,
        params: { max, radar, symbols },
        universe: uniOut,
        ...one,
      };
    }

    // ALWAYS heartbeat
    await kv.set(
      CRON_HEARTBEAT_KEY,
      {
        ts: Date.now(),
        mode,
        params: { max, radar, symbols },
        ok: !!out?.ok,
      },
      { ex: CRON_HEARTBEAT_TTL_SEC }
    );

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(
      JSON.stringify({
        ...out,
        cadence: "30m",
        tookMs: Date.now() - startedAt,
        heartbeatKey: CRON_HEARTBEAT_KEY,
        lock: { key: CRON_LOCK_KEY, ttlSec: CRON_LOCK_TTL_SEC },
        note: "Eén universe-run, daarna bull/bear (map_refresh → sampler → scan). Discord-berichten via cron zijn uitgeschakeld.",
      })
    );
  } catch (e) {
    try {
      await kv.set(
        CRON_HEARTBEAT_KEY,
        { ts: Date.now(), ok: false, error: String(e?.message || e) },
        { ex: CRON_HEARTBEAT_TTL_SEC }
      );
    } catch {}

    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  } finally {
    if (gotLock) await releaseLock();
  }
}