import scan from "./scan.js";

export const config = { runtime: "nodejs" };

// ✅ cron beschermen: header OF querystring secret
function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // open als je geen secret gebruikt (niet aangeraden)

  const auth = req.headers?.authorization || "";
  if (auth === `Bearer ${secret}`) return true;

  // ✅ Allow: /api/cron?secret=....
  try {
    const url = new URL(req.url, "https://local");
    const qs = url.searchParams.get("secret") || "";
    if (qs === secret) return true;
  } catch {}

  res.statusCode = 401;
  res.setHeader?.("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
  return false;
}

// mini “fake res” voor het intern aanroepen van scan.js
function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v;
    },
    end(txt) {
      this.body = txt || "";
    },
  };
}

export default async function handler(req, res) {
  try {
    if (!requireCron(req, res)) return;

    const secret = process.env.CRON_SECRET || "";
    const authHeader = secret ? { authorization: `Bearer ${secret}` } : {};

    // ✅ scan.js krijgt auth mee
    const reqBull = { method: "GET", url: "/api/scan?mode=bull", headers: authHeader };
    const reqBear = { method: "GET", url: "/api/scan?mode=bear", headers: authHeader };

    const resBull = makeRes();
    const resBear = makeRes();

    await scan(reqBull, resBull);
    await scan(reqBear, resBear);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        ts: Date.now(),
        bull: safeJson(resBull.body),
        bear: safeJson(resBear.body),
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}

function safeJson(txt) {
  try {
    return JSON.parse(txt);
  } catch {
    return { raw: String(txt || "") };
  }
}