/* EOF: /lib/_runtime.js */
export const RUNTIME_CONFIG = { runtime: "nodejs" };

function allSecrets() {
  return [
    process.env.CC_SECRET,
    process.env.CRON_SECRET,
    process.env.SECRET,
    process.env.API_SECRET,
  ]
    .map((x) => String(x || "").trim())
    .filter(Boolean);
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

// Vercel Cron header
function isVercelCron(req) {
  const v = String(header(req, "x-vercel-cron") || "").trim();
  return v === "1" || v.toLowerCase() === "true";
}

export function requireSecret(req, res) {
  // 1) Cron mag altijd door
  if (isVercelCron(req)) return true;

  const secrets = allSecrets();
  if (!secrets.length) return true; // geen secret ingesteld => publiek

  const bearer = String(header(req, "authorization") || "");
  const apiKey = String(header(req, "x-api-key") || "");
  const token = String(q(req, "token") || q(req, "secret") || "");

  const ok = secrets.some((s) => apiKey === s || token === s || bearer === `Bearer ${s}`);
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