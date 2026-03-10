// /lib/_moon_core.js

export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ================== MODE ==================
export function getMoonMode(input) {
  const raw =
    typeof input === "string"
      ? input
      : String(input?.query?.mode || input?.mode || "bull");

  return raw.toLowerCase() === "bear" ? "bear" : "bull";
}

// ================== SECRETS / AUTH ==================
export function requireSecret(req, res) {
  const authHeader = String(req.headers?.authorization || "");
  const bearer =
    authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

  const token =
    String(req.query?.token || "") ||
    bearer ||
    String(req.headers?.["x-cron-secret"] || "") ||
    String(req.headers?.["x-token"] || "");

  const secret = String(process.env.CRON_SECRET || "");
  if (!secret) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET env var" }));
    return false;
  }

  if (!token || token !== secret) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: false,
      error: "Unauthorized",
      hint: "Expected token query param, Bearer authorization header, x-cron-secret, or x-token",
    }));
    return false;
  }

  return true;
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return String(v);
}

// ================== FETCH WITH TIMEOUT ==================
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000, fetchFn = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    return await fetchFn(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ================== DISCORD HELPERS ==================
function safeWebhookUrl(value) {
  const s = String(value || "").trim();
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : "";
  } catch {
    return "";
  }
}

export async function sendDiscord(webhookUrl, content, fetchFn = fetch) {
  const url = safeWebhookUrl(webhookUrl);
  if (!url) return { ok: false, skip: true, reason: "invalid webhook URL" };

  const max = 1800;
  let text = String(content || "");
  const chunks = [];

  while (text.length > max) {
    chunks.push(text.slice(0, max));
    text = text.slice(max);
  }
  if (text) chunks.push(text);

  try {
    for (const chunk of chunks) {
      const r = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: chunk }),
        },
        8000,
        fetchFn
      );

      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return { ok: false, status: r.status, error: body.slice(0, 200) };
      }
    }

    return { ok: true, count: chunks.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function webhookForMoonStage(stage) {
  const s = String(stage || "").toUpperCase();
  if (s === "BUILDUP") return safeWebhookUrl(process.env.DISCORD_WEBHOOK_BUILDUP_MOON);
  if (s === "ALMOST") return safeWebhookUrl(process.env.DISCORD_WEBHOOK_ALMOST_MOON);
  if (s === "ELITE") return safeWebhookUrl(process.env.DISCORD_WEBHOOK_ELITE_MOON);
  return "";
}

export function webhookMoonPortfolio() {
  return (
    safeWebhookUrl(process.env.DISCORD_WEBHOOK_PORTFOLIO_MOON) ||
    safeWebhookUrl(process.env.DISCORD_WEBHOOK_ELITE_MOON)
  );
}

// ================== FORMAT HELPERS ==================
export function fmtModeLabel(mode) {
  return String(mode).toLowerCase() === "bear" ? "SHORT" : "LONG";
}

export function fmtTs(ts) {
  const d = new Date(Number(ts || 0) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${da} ${h}:${mi}`;
}

export function durMinutes(a, b) {
  const A = Number(a || 0);
  const B = Number(b || 0);
  if (!(A > 0 && B > 0 && B >= A)) return 0;
  return Math.round((B - A) / 60000);
}

export function fmtMoonLine(item, mode, extra = "", tsNow = Date.now()) {
  const side = fmtModeLabel(mode);
  const sym = String(item?.symbol || "");
  const stage = String(item?.stage || "");
  const px = Number(item?.price || 0);
  const ch = Number(item?.change24 || 0);
  const vm = Number(item?.vm || 0);
  const confRaw = Number(item?.confidence ?? item?.edgeScore ?? 0);
  const conf = confRaw <= 1 ? confRaw * 100 : confRaw;

  const ob = item?.ob || {};
  const obScore = Number(ob?.score ?? 0);
  const spread = Number(ob?.spreadPct ?? 0);

  const line1 = `**${sym}** → **${stage}** (MOON ${side})`;
  const line2 = `t: ${fmtTs(tsNow)} | $${px.toFixed(8)} | 24h: ${ch >= 0 ? "+" : ""}${ch.toFixed(2)}% | VM: ${vm.toFixed(3)} | conf: ${conf.toFixed(0)}`;
  const line3 = `OB: score ${obScore.toFixed(4)} | spread ${spread.toFixed(3)}%`;
  const line4 = extra ? `\n${extra}` : "";
  return `${line1}\n${line2}\n${line3}${line4}`;
}

// ================== KEYS ==================
const NS = "cc:moon";

export const keyMoonLatest = (mode) => `${NS}:latest:${getMoonMode(mode)}`;
export const keyMoonState = (mode) => `${NS}:state:${getMoonMode(mode)}`;
export const keyMoonReset = (mode) => `${NS}:reset:${getMoonMode(mode)}`;
export const keyMoonPortfolio = (mode) => `${NS}:portfolio:${getMoonMode(mode)}`;
export const keyMoonPositions = (mode) => `${NS}:positions:${getMoonMode(mode)}`;

export const keyMoonObSamples = (mode, symbol) =>
  `${NS}:ob:samples:${getMoonMode(mode)}:${String(symbol).toUpperCase()}`;

export const keyMoonObResult = (mode, symbol) =>
  `${NS}:ob:result:${getMoonMode(mode)}:${String(symbol).toUpperCase()}`;

export const keyMoonDiagList = (mode) => `${NS}:diag:list:${getMoonMode(mode)}`;
export const keyMoonDiagSnap = (mode) => `${NS}:diag:snap:${getMoonMode(mode)}`;

export const keyMoonScanLock = (mode) => `${NS}:scan_lock:${getMoonMode(mode)}`;
export const keyMoonCooldown = (mode, symbol) =>
  `${NS}:cooldown:${getMoonMode(mode)}:${String(symbol).toUpperCase()}`;