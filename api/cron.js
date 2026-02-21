// /api/cron.js
import scan from "./scan.js";
import obSampler from "./ob-sampler.js";
import obMapRefresh from "./ob_map_refresh.js";

// ⚠️ Belangrijk: gebruik een core die echt bestaat.
// Als jij geen /api/_core.js hebt, moet dit weg.
// Gebruik dan bv bull core voor requireSecret + runtime.
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

    const secret = process.env.CRON_SECRET || "";
    const authHeader = secret ? { authorization: `Bearer ${secret}` } : {};

    const reqBull = { method: "GET", query: { mode: "bull" }, headers: authHeader };
    const reqBear = { method: "GET", query: { mode: "bear" }, headers: authHeader };

    // 1) OB samples bouwen (maakt ob:result:*)
    const resObBull = makeRes();
    const resObBear = makeRes();
    await obSampler(reqBull, resObBull);
    await obSampler(reqBear, resObBear);

    // 2) OB map refresh (maakt ob:resultmap:*)
    const resMapBull = makeRes();
    const resMapBear = makeRes();
    await obMapRefresh(reqBull, resMapBull);
    await obMapRefresh(reqBear, resMapBear);

    // 3) Scan (leest 1x obMap)
    const resBull = makeRes();
    const resBear = makeRes();
    await scan(reqBull, resBull);
    await scan(reqBear, resBear);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      obBull: safeJson(resObBull.body),
      obBear: safeJson(resObBear.body),
      obMapBull: safeJson(resMapBull.body),
      obMapBear: safeJson(resMapBear.body),
      bull: safeJson(resBull.body),
      bear: safeJson(resBear.body),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok:false, error:String(e) }));
  }
}