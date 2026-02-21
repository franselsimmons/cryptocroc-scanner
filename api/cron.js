import scan from "./scan.js";
import obSampler from "./ob/sampler.js";
import obMapRefresh from "./ob/map_refresh.js";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
    end(txt) { this.body = txt || ""; }
  };
}
function safeJson(txt) { try { return JSON.parse(txt); } catch { return { raw: String(txt || "") }; } }

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req);

    // We geven internal calls ook Bearer mee zodat dezelfde requireSecret werkt
    const secret = String(process.env.CRON_SECRET || "");
    const authHeader = secret ? { authorization: `Bearer ${secret}` } : {};

    const reqMode = {
      method: "GET",
      query: { mode, max: "20", radar: "40" },
      headers: authHeader
    };

    // 1) OB samples
    const rOb = makeRes();
    await obSampler(reqMode, rOb);

    // 2) OB map refresh (timestamp)
    const rMap = makeRes();
    await obMapRefresh(reqMode, rMap);

    // 3) MAIN scan
    const rScan = makeRes();
    await scan(reqMode, rScan);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      mode,
      ob: safeJson(rOb.body),
      obMap: safeJson(rMap.body),
      scan: safeJson(rScan.body)
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}