import scanHandler from "./scan.js";
import { json } from "./_core.js";

function mkReq(url, headers = {}) {
  return { url, headers };
}
function mkRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    end() {}
  };
}

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET;

    // Vercel Cron stuurt Authorization: Bearer <CRON_SECRET> als jij die env var zet
    if (secret) {
      const auth = req.headers?.authorization || req.headers?.Authorization;
      if (auth !== `Bearer ${secret}`) {
        return json(res, 401, { error: "Unauthorized" });
      }
    }

    // bull + bear achter elkaar
    await scanHandler(mkReq("http://localhost/api/scan?mode=bull"), mkRes());
    await scanHandler(mkReq("http://localhost/api/scan?mode=bear"), mkRes());

    return json(res, 200, { ok: true, ts: Date.now() });
  } catch (e) {
    return json(res, 500, { error: String(e) });
  }
}
