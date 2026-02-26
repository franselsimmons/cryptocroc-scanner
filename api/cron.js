// /api/cron.js
import { kv } from "@vercel/kv";

import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";

import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import { sendDiscord } from "../lib/discord.js";
import { formatStage } from "../lib/formatDiscord.js";

export const config = RUNTIME_CONFIG;

// --------------------
// mini response object (voor interne handler-calls)
// --------------------
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    end(txt) {
      this.body = txt || "";
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
  // ✅ BELANGRIJK: default = both, zodat bull nooit “vergeten” wordt
  return "both";
}

function stageSymbols(arr) {
  return (arr || [])
    .map((x) => String(x?.symbol || "").toUpperCase())
    .filter(Boolean)
    .slice(0, 50);
}

// --------------------
// Discord MAIN tables (anti-spam: alleen als lijst veranderd is)
// --------------------
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
    ENTRY: process.env.DISCORD_WEBHOOK_ELITE || "", // ENTRY -> ELITE
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

    // 1 uur onthouden
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
  return (
    process.env.CC_SECRET ||
    process.env.SECRET ||
    process.env.API_SECRET ||
    process.env.CRON_SECRET ||
    ""
  );
}

// ✅ bouw interne req die ALLES meegeeft (query + headers)
// zodat requireSecret in sub-handlers nooit “net anders” faalt
function makeInternalReq({ base, path, mode, max, radar, secret }) {
  const qs = [];
  qs.push(`mode=${encodeURIComponent(mode)}`);
  if (max !== undefined) qs.push(`max=${encodeURIComponent(String(max))}`);
  if (radar !== undefined) qs.push(`radar=${encodeURIComponent(String(radar))}`);
  if (secret) qs.push(`secret=${encodeURIComponent(secret)}`);

  const url = `${base}${path}?${qs.join("&")}`;

  const query = { mode };
  if (max !== undefined) query.max = String(max);
  if (radar !== undefined) query.radar = String(radar);
  if (secret) query.secret = secret;

  const headers = {};
  if (secret) {
    headers["x-api-key"] = secret;
    headers["authorization"] = `Bearer ${secret}`;
  }

  return { method: "GET", url, query, headers };
}

function assertOk(name, parsed, resObj) {
  // als handler zelf JSON terugstuurt met ok:false, wil je het DIRECT zien
  if (parsed?.ok === false) {
    throw new Error(
      `${name} returned ok:false (status ${resObj?.statusCode || "?"}) :: ${parsed?.error || parsed?.msg || parsed?.reason || parsed?.raw || "unknown"}`
    );
  }
  // sommige handlers geven geen ok veld maar wél error
  if (parsed?.error) {
    throw new Error(`${name} error :: ${parsed.error}`);
  }
}

// --------------------
// run 1 mode end-to-end
// --------------------
async function runOneMode(mode, max, radar, secret) {
  const base = "http://localhost";

  const reqOb = makeInternalReq({
    base,
    path: "/api/ob/sampler",
    mode,
    max,
    radar,
    secret,
  });

  const reqMap = makeInternalReq({
    base,
    path: "/api/ob/map_refresh",
    mode,
    secret,
  });

  const reqScan = makeInternalReq({
    base,
    path: "/api/scan",
    mode,
    max,
    radar,
    secret,
  });

  // 1) OB sampler
  const resOb = makeRes();
  await obSampler(reqOb, resOb);
  const obOut = safeJson(resOb.body);
  assertOk(`obSampler(${mode})`, obOut, resOb);

  // 2) map_refresh
  const resMap = makeRes();
  await obMapRefresh(reqMap, resMap);
  const mapOut = safeJson(resMap.body);
  assertOk(`obMapRefresh(${mode})`, mapOut, resMap);

  // 3) scan
  const resScan = makeRes();
  await scan(reqScan, resScan);
  const scanOut = safeJson(resScan.body);
  assertOk(`scan(${mode})`, scanOut, resScan);

  // 4) Discord updates
  const discord = await notifyMainDiscord(mode, scanOut);

  return {
    mode,
    ob: obOut,
    obMap: mapOut,
    scan: scanOut,
    discord,
  };
}

// --------------------
// handler
// --------------------
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const secret = pickSecret();

    const mode = normMode(req?.query?.mode);

    const max = q(req, "max", "20");
    const radar = q(req, "radar", "40");

    // ✅ JUISTE VOLGORDE voor jouw design:
    // OB sampler -> map_refresh -> scan -> discord

    let out = null;

    if (mode === "both") {
      const bull = await runOneMode("bull", max, radar, secret);
      const bear = await runOneMode("bear", max, radar, secret);
      out = { ok: true, ts: Date.now(), mode: "both", params: { max, radar }, bull, bear };
    } else {
      const one = await runOneMode(mode, max, radar, secret);
      out = { ok: true, ts: Date.now(), mode, params: { max, radar }, ...one };
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(
      JSON.stringify({
        ...out,
        cadence: "30m",
        note:
          "Fix: default mode=both + hard-fail if any sub-handler returns ok:false. This prevents 'bear updates but bull frozen'.",
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}