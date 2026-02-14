import scan from "./scan.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;

  // Vercel Cron stuurt automatisch Authorization: Bearer <CRON_SECRET>
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${secret}`) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
  }

  // scan bull + bear (maar scan zelf beslist obv BTC gate)
  await scan({ url: "/api/scan?mode=bull" }, dummyRes());
  await scan({ url: "/api/scan?mode=bear" }, dummyRes());

  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, ran: ["bull", "bear"], ts: Date.now() }));
}

function dummyRes() {
  return {
    statusCode: 200,
    setHeader() {},
    end() {}
  };
}
