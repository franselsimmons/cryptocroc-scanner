// api/cron.js
import { kv } from "@vercel/kv";

import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";

import { requireSecret, getMode, RUNTIME_CONFIG } from "../lib/_runtime.js";
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
  try { return JSON.parse(txt); } catch { return { raw: String(txt || "") }; }
}

function q(req, key, def) {
  const v = req?.query?.[key];
  if (v === undefined || v === null || v === "") return def;
  return String(v);
}

function stageSymbols(arr) {
  return (arr || []).map(x => String(x?.symbol || "")).filter(Boolean).slice(0, 50);
}

async function notifyMainDiscord(mode, scanResult) {
  // scanResult = output van scan2
  const funnel = scanResult?.funnel || {};
  const radar  = funnel.radar  || [];
  const buildup= funnel.buildup|| [];
  const almost = funnel.almost || [];
  const entry  = funnel.entry  || [];

  // Welke webhook hoort bij welke tabel
  const hooks = {
    RADAR:  process.env.DISCORD_WEBHOOK_RADAR || "",
    BUILDUP:process.env.DISCORD_WEBHOOK_BUILDUP || "",
    ALMOST: process.env.DISCORD_WEBHOOK_ALMOST || "",
    ENTRY:  process.env.DISCORD_WEBHOOK_ELITE || "", // “ELITE” = ENTRY bij jou
  };

  // Anti-spam: alleen sturen als lijst veranderd is
  async function sendIfChanged(stageName, coins) {
    const hook = hooks[stageName];
    if (!hook) return { stageName, sent: false, why: "no webhook set" };

    const syms = stageSymbols(coins);
    if (syms.length === 0) return { stageName, sent: false, why: "empty" };

    const key = `discord:last:main:${mode}:${stageName}`;
    const prev = (await kv.get(key)) || "";
    const nowSig = syms.join(",");

    if (prev === nowSig) return { stageName, sent: false, why: "no change" };

    // We gebruiken jouw formatter: bullCoins/bearCoins -> wij vullen er 1 (mode) en laten de andere leeg
    const text = formatStage(
      `${stageName} (MAIN ${mode.toUpperCase()})`,
      mode === "bull" ? coins : [],
      mode === "bear" ? coins : []
    );

    if (!text) return { stageName, sent: false, why: "formatStage empty" };

    await sendDiscord(hook, `CryptoCroc MAIN • ${stageName}`, text);

    await kv.set(key, nowSig, { ex: 60 * 60 }); // 1 uur onthouden
    return { stageName, sent: true, count: syms.length };
  }

  const r1 = await sendIfChanged("ENTRY", entry);
  const r2 = await sendIfChanged("ALMOST", almost);
  const r3 = await sendIfChanged("BUILDUP", buildup);
  const r4 = await sendIfChanged("RADAR", radar);

  return { ok: true, results: [r1, r2, r3, r4] };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // bull/bear

    const max = q(req, "max", "20");
    const radar = q(req, "radar", "40");

    // ✅ geef sub-handlers exact dezelfde secret mee
    const expected =
      process.env.CC_SECRET ||
      process.env.SECRET ||
      process.env.API_SECRET ||
      process.env.CRON_SECRET ||
      "";

    const base = "http://localhost";

    const reqScan = {
      method: "GET",
      url: `${base}/api/scan?mode=${mode}&max=${encodeURIComponent(max)}&radar=${encodeURIComponent(radar)}${expected ? `&secret=${encodeURIComponent(expected)}` : ""}`,
      query: expected ? { mode, max, radar, secret: expected } : { mode, max, radar },
      headers: expected ? { "x-api-key": expected } : {},
    };

    const reqMap = {
      method: "GET",
      url: `${base}/api/ob/map_refresh?mode=${mode}${expected ? `&secret=${encodeURIComponent(expected)}` : ""}`,
      query: expected ? { mode, secret: expected } : { mode },
      headers: expected ? { "x-api-key": expected } : {},
    };

    const reqOb = {
      method: "GET",
      url: `${base}/api/ob/sampler?mode=${mode}&max=${encodeURIComponent(max)}&radar=${encodeURIComponent(radar)}${expected ? `&secret=${encodeURIComponent(expected)}` : ""}`,
      query: expected ? { mode, max, radar, secret: expected } : { mode, max, radar },
      headers: expected ? { "x-api-key": expected } : {},
    };

    // 1) scan
    const resScan1 = makeRes();
    await scan(reqScan, resScan1);

    // 2) map_refresh
    const resMap = makeRes();
    await obMapRefresh(reqMap, resMap);

    // 3) ob sampler
    const resOb = makeRes();
    await obSampler(reqOb, resOb);

    // 4) scan opnieuw
    const resScan2 = makeRes();
    await scan(reqScan, resScan2);

    const scan2 = safeJson(resScan2.body);

    // ✅ DISCORD NA scan2
    const discord = await notifyMainDiscord(mode, scan2);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      mode,
      params: { max, radar },
      scan1: safeJson(resScan1.body),
      obMap: safeJson(resMap.body),
      ob: safeJson(resOb.body),
      scan2,
      discord,
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}