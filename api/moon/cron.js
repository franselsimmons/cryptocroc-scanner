// /api/moon/cron.js
import scan from "./scan.js";
import { RUNTIME_CONFIG, requireSecret } from "../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  return res.end(JSON.stringify(obj));
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = String(v);
    },
    status(code) {
      this.statusCode = Number(code) || 200;
      return this;
    },
    json(obj) {
      this.setHeader("content-type", "application/json; charset=utf-8");
      this.end(JSON.stringify(obj));
      return this;
    },
    end(txt) {
      this.body = String(txt || "");
      return this;
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

function isVercelCron(req) {
  const h = req?.headers || {};
  const v =
    h["x-vercel-cron"] ||
    h["x-vercel-cron-job"] ||
    h["X-Vercel-Cron"] ||
    h["X-Vercel-Cron-Job"];

  return String(v || "") !== "";
}

function makeInternalReq(req, mode) {
  const token = String(process.env.CRON_SECRET || "");

  return {
    method: "GET",
    query: {
      mode: String(mode),
      token,
    },
    headers: {
      ...(req?.headers || {}),
      authorization: token ? `Bearer ${token}` : "",
      "x-api-key": token,
    },
    url: `/api/moon/scan?mode=${encodeURIComponent(mode)}&token=${encodeURIComponent(token)}`,
  };
}

function assertOkSoft(name, parsed, resObj) {
  if (parsed?.ok === false) {
    return {
      ok: false,
      error: `${name} returned ok:false (status ${resObj?.statusCode || "?"}) :: ${
        parsed?.error || parsed?.raw || "unknown"
      }`,
    };
  }

  if (parsed?.error) {
    return {
      ok: false,
      error: `${name} error :: ${parsed.error}`,
    };
  }

  return { ok: true };
}

async function runMode(req, mode) {
  const internalReq = makeInternalReq(req, mode);
  const internalRes = makeRes();

  await scan(internalReq, internalRes);

  const out = safeJson(internalRes.body);
  const check = assertOkSoft(`moonScan(${mode})`, out, internalRes);

  return {
    mode,
    ok: !!check.ok,
    status: internalRes.statusCode || 200,
    errors: check.ok ? [] : [check.error],
    body: out,
  };
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    // Vercel Cron direct toestaan
    if (!isVercelCron(req)) {
      // Handmatig testen => secret verplicht
      if (!requireSecret(req, res)) return;
    }

    const [bullRes, bearRes] = await Promise.allSettled([
      runMode(req, "bull"),
      runMode(req, "bear"),
    ]);

    const bull =
      bullRes.status === "fulfilled"
        ? bullRes.value
        : {
            mode: "bull",
            ok: false,
            status: 500,
            errors: [String(bullRes.reason?.message || bullRes.reason || "bull failed")],
            body: null,
          };

    const bear =
      bearRes.status === "fulfilled"
        ? bearRes.value
        : {
            mode: "bear",
            ok: false,
            status: 500,
            errors: [String(bearRes.reason?.message || bearRes.reason || "bear failed")],
            body: null,
          };

    const ok = !!bull.ok && !!bear.ok;

    return send(res, ok ? 200 : 500, {
      ok,
      cron: true,
      ts: Date.now(),
      cadence: "15m",
      tookMs: Date.now() - startedAt,
      result: {
        bull,
        bear,
      },
    });
  } catch (e) {
    return send(res, 500, {
      ok: false,
      cron: true,
      error: String(e?.message || e),
    });
  }
}