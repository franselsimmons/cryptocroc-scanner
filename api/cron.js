import scan from "./scan.js";

export const config = { runtime: "nodejs" };

function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // als jij geen secret wil: dan alles open (niet aangeraden)
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end("Unauthorized");
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  try {
    if (!requireCron(req, res)) return;

    // scan bull + bear
    await scan({ url: "/api/scan?mode=bull" }, { statusCode: 200, setHeader() {}, end() {} });
    await scan({ url: "/api/scan?mode=bear" }, { statusCode: 200, setHeader() {}, end() {} });

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
  } catch (e) {
    res.statusCode = 500;
    res.end(String(e));
  }
}
