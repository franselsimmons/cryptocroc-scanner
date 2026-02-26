// /api/cron.js
import { kv } from "@vercel/kv";

import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";

import { requireSecret, getMode, RUNTIME_CONFIG } from "../lib/_runtime.js";
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
    return { raw: String(txt || "") };
  }
}

function q(req, key, def) {
  const v = req?.query?.[key];
  if (v === undefined || v === null || v === "") return def;
  return String(v);
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

  // ENTRY eerst (belangrijkste)
  const r1 = await sendIfChanged("ENTRY", entry);
  const r2 = await sendIfChanged("ALMOST", almost);
  const r3 = await sendIfChanged("BUILDUP", buildup);
  const r4 = await sendIfChanged("RADAR", radar);

  return { ok: true, results: [r1, r2, r3, r4] };
}

// --------------------
// handler
// --------------------
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // bull/bear

    // (optioneel) doorgeven naar ob sampler / scan
    // max = hoeveel candidates per run
    // radar = hoeveel radar candidates meepakken in picker
    const max = q(req, "max", "20");
    const radar = q(req, "radar", "40");

    // ✅ geef sub-handlers exact dezelfde secret mee
    const expected =
      process.env.CC_SECRET ||
      process.env.SECRET ||
      process.env.API_SECRET ||
      process.env.CRON_SECRET ||
      "";

    // fake URL base (wordt alleen gebruikt omdat scan/ob handlers URL willen parsen)
    const base = "http://localhost";

    const reqOb = {
      method: "GET",
      url: `${base}/api/ob/sampler?mode=${mode}&max=${encodeURIComponent(
        max
      )}&radar=${encodeURIComponent(radar)}${
        expected ? `&secret=${encodeURIComponent(expected)}` : ""
      }`,
      query: expected ? { mode, max, radar, secret: expected } : { mode, max, radar },
      headers: expected ? { "x-api-key": expected } : {},
    };

    const reqMap = {
      method: "GET",
      url: `${base}/api/ob/map_refresh?mode=${mode}${
        expected ? `&secret=${encodeURIComponent(expected)}` : ""
      }`,
      query: expected ? { mode, secret: expected } : { mode },
      headers: expected ? { "x-api-key": expected } : {},
    };

    const reqScan = {
      method: "GET",
      url: `${base}/api/scan?mode=${mode}&max=${encodeURIComponent(
        max
      )}&radar=${encodeURIComponent(radar)}${
        expected ? `&secret=${encodeURIComponent(expected)}` : ""
      }`,
      query: expected ? { mode, max, radar, secret: expected } : { mode, max, radar },
      headers: expected ? { "x-api-key": expected } : {},
    };

    // =========================================================
    // ✅ JUISTE VOLGORDE voor jouw 30m design
    // 1) OB sampler  -> verzamelt/valideert samples (KV ob:samples + ob:result)
    // 2) map_refresh -> maakt ob:map:<mode> voor snelle lookups
    // 3) scan        -> gebruikt verse OB resultaten + map
    // 4) discord main (optioneel) -> alleen als tabel-lijst veranderd is
    // =========================================================

    // 1) OB sampler
    const resOb = makeRes();
    await obSampler(reqOb, resOb);

    // 2) map_refresh
    const resMap = makeRes();
    await obMapRefresh(reqMap, resMap);

    // 3) scan (final scan die je website/discord gebruikt)
    const resScan = makeRes();
    await scan(reqScan, resScan);

    const scanOut = safeJson(resScan.body);

    // 4) Discord MAIN updates (anti-spam)
    const discord = await notifyMainDiscord(mode, scanOut);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(
      JSON.stringify({
        ok: true,
        ts: Date.now(),
        mode,
        cadence: "30m",
        params: { max, radar },
        ob: safeJson(resOb.body),
        obMap: safeJson(resMap.body),
        scan: scanOut,
        discord,
        note:
          "Cron order fixed: OB sampler -> ob map_refresh -> scan -> discord. This matches samplesNeed/window for 30m cadence.",
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}