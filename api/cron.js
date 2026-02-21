// /api/cron.js
import scan from "./scan.js";
import obSampler from "./ob-sampler.js";
import obMapRefresh from "./ob_map_refresh.js";

// Gebruik bull core voor requireSecret (werkt voor beide modes)
import { RUNTIME_CONFIG, requireSecret } from "./_core_bull.js";

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

    // Stel parameters in voor ob-sampler: vaste aantallen per run
    const reqMode = {
      method: "GET",
      query: { mode, max: "20", radar: "40" },
      headers: authHeader,
    };

    // 1) OB samples bouwen
    const resOb = makeRes();
    await obSampler(reqMode, resOb);

    // 2) OB map refreshen
    const resMap = makeRes();
    await obMapRefresh(reqMode, resMap);

    // 3) Scannen
    const resScan = makeRes();
    await scan(reqMode, resScan);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
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
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}