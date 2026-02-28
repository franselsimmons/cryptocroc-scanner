// /api/cron.js
import { kv } from "@vercel/kv";

import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";

import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import { sendDiscord } from "../lib/discord.js";
import { formatStage } from "../lib/formatDiscord.js";

export const config = RUNTIME_CONFIG;

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(txt) { this.body = txt || ""; },
  };
}

function safeJson(txt) {
  try { return JSON.parse(txt); } catch { return { ok: false, raw: String(txt || "") }; }
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

function stageSymbols(arr) {
  return (arr || [])
    .map((x) => String(x?.symbol || "").toUpperCase())
    .filter(Boolean)
    .slice(0, 50);
}

async function notifyMainDiscord(mode, scanResult) {
  const funnel = scanResult?.funnel || {};
  const radar = funnel.radar || [];
  const buildup = funnel.buildup || [];
  const almost = funnel.almost || [];
  const entry = funnel.entry || [];

  const hooks = {
    RADAR: process.env.DISCORD_WEBHOOK_RADAR || "",
    BUILDUP: process.env.DISCORD_WEBHOOK_BUILDUP || "",
    ALMOST: process.env.DISCORD_WEBHOOK_ALMOST || "",
    ENTRY: process.env.DISCORD_WEBHOOK_ELITE || "",
  };

  async function sendIfChanged(stageName, coins) {
    const hook = hooks[stageName];
    if (!hook) return { stageName, sent: false, why: "no webhook set" };

    const syms = stageSymbols(coins);
    if (syms.length === 0) return { stageName, sent: false, why: "empty" };

    const key = `discord:last:main:${mode}:${stageName}`;
    const prevSig = (await kv.get(key)) || "";
    const nowSig = syms.join(",");

    if (prevSig === nowSig) return { stageName, sent: false, why: "no change" };

    const text = formatStage(
      `${stageName} (MAIN ${mode.toUpperCase()})`,
      mode === "bull" ? coins : [],
      mode === "bear" ? coins : []
    );

    if (!text) return { stageName, sent: false, why: "formatStage empty" };

    await sendDiscord(hook, `CryptoCroc MAIN • ${stageName}`, text);
    await kv.set(key, nowSig, { ex: 60 * 60 });

    return { stageName, sent: true, count: syms.length };
  }

  const r1 = await sendIfChanged("ENTRY", entry);
  const r2 = await sendIfChanged("ALMOST", almost);
  const r3 = await sendIfChanged("BUILDUP", buildup);
  const r4 = await sendIfChanged("RADAR", radar);

  return { ok: true, results: [r1, r2, r3, r4] };
}

function pickSecret() {
  return (process.env.CC_SECRET || process.env.SECRET || process.env.API_SECRET || process.env.CRON_SECRET || "");
}

function makeInternalReq({ mode, max, radar, secret }) {
  const query = { mode };
  if (max !== undefined) query.max = String(max);
  if (radar !== undefined) query.radar = String(radar);
  if (secret) query.secret = secret;

  const headers = {};
  if (secret) {
    headers["x-api-key"] = secret;
    headers["authorization"] = `Bearer ${secret}`;
  }

  return { method: "GET", query, headers };
}

function assertOk(name, parsed, resObj) {
  if (parsed?.ok === false) {
    throw new Error(`${name} returned ok:false (status ${resObj?.statusCode || "?"}) :: ${parsed?.error || parsed?.raw || "unknown"}`);
  }
  if (parsed?.error) throw new Error(`${name} error :: ${parsed.error}`);
}

const CRON_LOCK_KEY = "lock:cron";
const CRON_LOCK_TTL_SEC = 25 * 60;

async function acquireLock() {
  const ok = await kv.set(CRON_LOCK_KEY, String(Date.now()), { nx: true, ex: CRON_LOCK_TTL_SEC });
  return !!ok;
}

async function releaseLock() {
  try { await kv.del(CRON_LOCK_KEY); } catch {}
}

async function runOneMode(mode, max, radar, secret) {
  const reqOb = makeInternalReq({ mode, max, radar, secret });
  const reqMap = makeInternalReq({ mode, secret });
  const reqScan = makeInternalReq({ mode, max, radar, secret });

  const resOb = makeRes();
  await obSampler(reqOb, resOb);
  const obOut = safeJson(resOb.body);
  assertOk(`obSampler(${mode})`, obOut, resOb);

  const resMap = makeRes();
  await obMapRefresh(reqMap, resMap);
  const mapOut = safeJson(resMap.body);
  assertOk(`obMapRefresh(${mode})`, mapOut, resMap);

  const resScan = makeRes();
  await scan(reqScan, resScan);
  const scanOut = safeJson(resScan.body);
  assertOk(`scan(${mode})`, scanOut, resScan);

  const discord = await notifyMainDiscord(mode, scanOut);

  return { ok: true, mode, ob: obOut, obMap: mapOut, scan: scanOut, discord };
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  try {
    if (!requireSecret(req, res)) return;

    const locked = await acquireLock();
    if (!locked) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: true, skipped: true, reason: "cron already running (lock active)", ts: Date.now() }));
    }

    const secret = pickSecret();
    const mode = normMode(req?.query?.mode);
    const max = q(req, "max", "20");
    const radar = q(req, "radar", "40");

    let out = null;

    if (mode === "both") {
      const [bullRes, bearRes] = await Promise.allSettled([
        runOneMode("bull", max, radar, secret),
        runOneMode("bear", max, radar, secret),
      ]);

      const bull = bullRes.status === "fulfilled" ? bullRes.value : { ok: false, error: String(bullRes.reason?.message || bullRes.reason || "bull failed") };
      const bear = bearRes.status === "fulfilled" ? bearRes.value : { ok: false, error: String(bearRes.reason?.message || bearRes.reason || "bear failed") };

      out = { ok: bull.ok && bear.ok, ts: Date.now(), mode: "both", params: { max, radar }, bull, bear };
    } else {
      const one = await runOneMode(mode, max, radar, secret);
      out = { ok: true, ts: Date.now(), mode, params: { max, radar }, ...one };
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({
      ...out,
      cadence: "30m",
      tookMs: Date.now() - startedAt,
      note: "Bull+bear parallel. Per mode: obSampler -> map_refresh -> scan -> discord. Scan logt events voor analyzer.",
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  } finally {
    await releaseLock();
  }
}