// /api/cron.js
import scan from "./scan.js";

export const config = { runtime: "nodejs" };

function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // niet aangeraden

  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end() {}
  };
}

export default async function handler(req, res) {
  try {
    if (!requireCron(req, res)) return;

    // scan bull + bear (de scan.js handelt zelf KV + output af)
    await scan({ url: "/api/scan?mode=bull", headers: {} }, fakeRes());
    await scan({ url: "/api/scan?mode=bear", headers: {} }, fakeRes());

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}