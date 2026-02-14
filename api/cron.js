import scan from "./scan.js";

export const config = { runtime: "nodejs" };

function mkReq(mode) {
  return { url: `/api/scan?mode=${mode}`, headers: {} };
}
function mkRes() {
  return {
    statusCode: 200,
    setHeader() {},
    end() {}
  };
}

export default async function handler(req, res) {
  try {
    const secret = process.env.CRON_SECRET ? String(process.env.CRON_SECRET).trim() : "";

    // Als je CRON_SECRET gezet hebt, moet cron-call de Bearer header matchen.
    if (secret) {
      const auth = req.headers?.authorization || req.headers?.Authorization || "";
      if (auth !== `Bearer ${secret}`) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    await scan(mkReq("bull"), mkRes());
    await scan(mkReq("bear"), mkRes());

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e?.message || e));
  }
}
