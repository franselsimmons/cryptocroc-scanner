import { RUNTIME_CONFIG, requireSecret } from "../../lib/_moon_core.js";
import runMoonScan from "./scan.js";

export const config = {
  ...RUNTIME_CONFIG,
  maxDuration: 60,
};

function makeReq(mode, token, originalReq) {
  return {
    ...originalReq,
    method: "GET",
    query: {
      ...(originalReq?.query || {}),
      mode,
      token,
    },
    headers: {
      ...(originalReq?.headers || {}),
      authorization: `Bearer ${token}`,
    },
  };
}

function createBufferRes() {
  let statusCode = 200;
  const headers = {};
  let body = "";

  return {
    get statusCode() {
      return statusCode;
    },
    set statusCode(v) {
      statusCode = v;
    },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    end(payload = "") {
      body = String(payload || "");
      return body;
    },
    json() {
      try {
        return JSON.parse(body || "{}");
      } catch {
        return { ok: false, error: body || "Invalid JSON body" };
      }
    },
    rawBody() {
      return body;
    },
  };
}

async function runOne(mode, req, token) {
  const subReq = makeReq(mode, token, req);
  const subRes = createBufferRes();

  await runMoonScan(subReq, subRes);

  const json = subRes.json();
  if (subRes.statusCode >= 400 || json?.ok === false) {
    throw new Error(
      `moon ${mode} failed: ${json?.error || subRes.rawBody() || `HTTP ${subRes.statusCode}`}`
    );
  }

  return json;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const token = String(process.env.CRON_SECRET || "").trim();
    if (!token) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: false,
        cron: true,
        error: "Missing CRON_SECRET env var",
      }));
    }

    const startedAt = Date.now();

    const bull = await runOne("bull", req, token);
    const bear = await runOne("bear", req, token);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: true,
      cron: true,
      startedAt,
      finishedAt: Date.now(),
      bull: {
        ts: bull?.ts || null,
        counts: bull?.counts || null,
        btc: bull?.btc || null,
      },
      bear: {
        ts: bear?.ts || null,
        counts: bear?.counts || null,
        btc: bear?.btc || null,
      },
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: false,
      cron: true,
      error: String(e?.message || e),
    }));
  }
}