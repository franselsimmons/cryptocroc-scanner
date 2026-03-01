export const RUNTIME_CONFIG = {
  runtime: "nodejs",
};

function pickSecret() {
  return (
    process.env.CC_SECRET ||
    process.env.CRON_SECRET ||
    process.env.SECRET ||
    process.env.API_SECRET ||
    ""
  );
}

function header(req, k) {
  const key = String(k || "").toLowerCase();
  const h = req?.headers || {};
  return h[key] || h[String(k || "")] || "";
}

function q(req, key) {
  const v = req?.query?.[key];
  if (v === undefined || v === null || v === "") return "";
  return String(v);
}

// Vercel Cron Jobs sturen deze header mee
function isVercelCron(req) {
  const v = String(header(req, "x-vercel-cron") || "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

export function requireSecret(req, res) {
  // 1) Als dit echt een Vercel Cron run is: ok
  if (isVercelCron(req)) return true;

  // 2) Als jij geen secret hebt gezet: dan is het publiek
  const secret = pickSecret();
  if (!secret) return true;

  // 3) Accepteer secret via:
  // - Authorization: Bearer <secret>
  // - x-api-key: <secret>
  // - x-cron-secret: <secret>   (handig voor cron/CI)
  // - query ?secret= of ?token=
  const bearer = String(header(req, "authorization") || "");
  const apiKey = String(header(req, "x-api-key") || "");
  const cronKey = String(header(req, "x-cron-secret") || "");
  const token = String(q(req, "token") || q(req, "secret") || "");

  const ok =
    apiKey === secret ||
    cronKey === secret ||
    token === secret ||
    bearer === `Bearer ${secret}`;

  if (ok) return true;

  if (res) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  }
  return false;
}

export function getMode(req) {
  const m = String(req?.query?.mode || "bull").toLowerCase();
  return m === "bear" ? "bear" : "bull";
}