import scan from "./scan.js";

export const config = { runtime: "nodejs" };

function mkReq(url, secret) {
  return {
    url,
    headers: secret ? { authorization: `Bearer ${secret}` } : {}
  };
}
function mkRes() {
  return { statusCode: 200, setHeader() {}, end() {} };
}

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET ? String(process.env.CRON_SECRET).trim() : "";

    // Cron endpoint zelf ook beveiligen (zelfde secret)
    if (secret) {
      const auth = req.headers?.authorization || req.headers?.Authorization || "";
      if (auth !== `Bearer ${secret}`) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    // 1 call: scan doet BTC gate + schrijft bull+bear in KV
    await scan(mkReq("/api/scan?mode=auto", secret), mkRes());

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}
