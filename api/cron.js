import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";
import { requireSecret } from "../lib/_runtime.js";

export const config = { runtime: "nodejs" };

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

export default async function handler(req, res) {
  try {
    // ✅ Secret check op 1 plek (runtime)
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    // ✅ parameters overridebaar
    const max = q(req, "max", "20");
    const radar = q(req, "radar", "40");

    const secret = process.env.CRON_SECRET || "";
    const authHeader = secret
      ? { authorization: `Bearer ${secret}`, Authorization: `Bearer ${secret}` }
      : {};

    // Zorg dat sub-handlers niet crashen als ze new URL(req.url) doen:
    const base = "http://localhost";

    const reqScan = {
      method: "GET",
      url: `${base}/api/scan?mode=${mode}&max=${encodeURIComponent(max)}&radar=${encodeURIComponent(radar)}`,
      query: { mode, max, radar },
      headers: authHeader,
    };

    const reqMap = {
      method: "GET",
      url: `${base}/api/ob/map_refresh?mode=${mode}`,
      query: { mode },
      headers: authHeader,
    };

    const reqOb = {
      method: "GET",
      url: `${base}/api/ob/sampler?mode=${mode}&max=${encodeURIComponent(max)}&radar=${encodeURIComponent(radar)}`,
      query: { mode, max, radar },
      headers: authHeader,
    };

    // =========================================================
    // 🔥 Kritische volgorde:
    // 1) scan -> maakt latest/funnel shortlist actueel
    // 2) map_refresh -> houdt symbol mapping up-to-date
    // 3) ob sampler -> vult KV met verse OB samples/results
    // 4) scan opnieuw -> ENTRY profiteert direct van verse OB
    // =========================================================

    const resScan1 = makeRes();
    await scan(reqScan, resScan1);

    const resMap = makeRes();
    await obMapRefresh(reqMap, resMap);

    const resOb = makeRes();
    await obSampler(reqOb, resOb);

    const resScan2 = makeRes();
    await scan(reqScan, resScan2);

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
      scan2: safeJson(resScan2.body),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}