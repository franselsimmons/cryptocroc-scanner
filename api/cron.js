import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";
import { requireSecret } from "../lib/_core_bull.js";

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

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    const secret = process.env.CRON_SECRET || "";
    const authHeader = secret ? { authorization: `Bearer ${secret}` } : {};

    // BELANGRIJK: interne handlers verwachten soms req.url (new URL(req.url,...))
    const base = "http://localhost";

    const reqOb = {
      method: "GET",
      url: `${base}/api/ob/sampler?mode=${mode}&max=20&radar=40`,
      query: { mode, max: "20", radar: "40" },
      headers: authHeader,
    };

    const reqMap = {
      method: "GET",
      url: `${base}/api/ob/map_refresh?mode=${mode}`,
      query: { mode },
      headers: authHeader,
    };

    const reqScan = {
      method: "GET",
      url: `${base}/api/scan?mode=${mode}&max=20&radar=40`,
      query: { mode, max: "20", radar: "40" },
      headers: authHeader,
    };

    const resOb = makeRes();
    await obSampler(reqOb, resOb);

    const resMap = makeRes();
    await obMapRefresh(reqMap, resMap);

    const resScan = makeRes();
    await scan(reqScan, resScan);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      mode,
      ob: safeJson(resOb.body),
      obMap: safeJson(resMap.body),
      scan: safeJson(resScan.body),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}