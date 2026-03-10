import { RUNTIME_CONFIG, requireSecret } from "../../lib/_moon_core.js";
import mapRefresh from "./ob/map_refresh.js";
import sampler from "./ob/sampler.js";
import scan from "./scan.js";

export const config = RUNTIME_CONFIG;

function createInternalReq(mode, originalReq) {
  return {
    ...originalReq,
    method: "GET",
    query: { mode, ...originalReq.query },
    headers: originalReq.headers,
  };
}

function createBufferRes() {
  let statusCode = 200;
  const headers = {};
  let body = "";
  return {
    statusCode,
    setHeader(k, v) { headers[String(k).toLowerCase()] = v; },
    end(payload) { body = String(payload || ""); return body; },
    json() {
      try { return JSON.parse(body); } catch { return { ok: false, raw: body }; }
    },
    get statusCode() { return statusCode; },
    set statusCode(v) { statusCode = v; },
  };
}

async function runStep(handler, mode, req) {
  const subReq = createInternalReq(mode, req);
  const subRes = createBufferRes();
  await handler(subReq, subRes);
  if (subRes.statusCode >= 400) {
    throw new Error(`Step failed with status ${subRes.statusCode}: ${subRes.json().error || subRes.json().raw || "unknown"}`);
  }
  return subRes.json();
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const token = String(process.env.CRON_SECRET || "").trim();
    if (!token) {
      return res.status(500).json({ ok: false, error: "Missing CRON_SECRET" });
    }

    const startedAt = Date.now();

    // 1. map_refresh voor bull
    await runStep(mapRefresh, "bull", req);
    // 2. sampler voor bull
    await runStep(sampler, "bull", req);
    // 3. scan voor bull
    const bull = await runStep(scan, "bull", req);

    // 4. zelfde voor bear
    await runStep(mapRefresh, "bear", req);
    await runStep(sampler, "bear", req);
    const bear = await runStep(scan, "bear", req);

    res.status(200).json({
      ok: true,
      cron: true,
      startedAt,
      finishedAt: Date.now(),
      bull: { ts: bull?.ts, counts: bull?.counts, btc: bull?.btc },
      bear: { ts: bear?.ts, counts: bear?.counts, btc: bear?.btc },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}