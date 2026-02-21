// /api/_portfolio_core.js
import { kv } from "@vercel/kv";

// ✅ GEEN nodejs20.x
export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ====== auth ======
export function requireSecret(req, res) {
  const cronHeader = String(req.headers?.["x-vercel-cron"] || "").toLowerCase();
  const isVercelCron = cronHeader === "1" || cronHeader === "true";
  if (isVercelCron) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers?.authorization || "";
  const token = req.query?.token ? String(req.query.token) : "";
  const ok = auth === `Bearer ${secret}` || token === secret;

  if (!ok) {
    res.statusCode = 401;
    res.setHeader?.("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

export const keyPortfolioState = "portfolio:state:v1";
export const keyPortfolioClosed = "portfolio:closed:v1";

export function tradeKey({ funnel, mode, symbol }) {
  return `${funnel}:${mode}:${String(symbol || "").toUpperCase()}`;
}

export async function sendDiscordPortfolio(content) {
  const url = process.env.DISCORD_WEBHOOK_PORTFOLIO;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {}
}

export function nowTs() {
  return Date.now();
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function fmt2(n) {
  return (Number(n) || 0).toFixed(2);
}

export function fmtUsd(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}

export function pct(a, b) {
  a = Number(a) || 0;
  b = Number(b) || 0;
  if (a === 0) return 0;
  return ((b - a) / a) * 100;
}

export function findCoinInLatest(latest, symbolUpper) {
  const sym = String(symbolUpper || "").toUpperCase();
  const f = latest?.funnel || {};

  const allLists = [
    ...(f.entry || []),
    ...(f.elite || []),
    ...(f.almost || []),
    ...(f.buildup || []),
    ...(f.radar || []),
  ];

  return allLists.find((x) => String(x?.symbol || "").toUpperCase() === sym) || null;
}

export function topStageForFunnel(funnel) {
  return funnel === "moon" ? "ELITE" : "ENTRY";
}

export function listTop(latest, funnel) {
  const f = latest?.funnel || {};
  if (funnel === "moon") return f.elite || [];
  return f.entry || [];
}

// (rest blijft exact zoals jij hem had)
export async function loadPortfolioState() {
  const s = (await kv.get(keyPortfolioState)) || null;
  if (s && typeof s === "object") {
    return {
      openByKey: s.openByKey && typeof s.openByKey === "object" ? s.openByKey : {},
      closed: Array.isArray(s.closed) ? s.closed : [],
    };
  }
  return { openByKey: {}, closed: [] };
}

export async function savePortfolioState(state) {
  await kv.set(keyPortfolioState, state);
  await kv.set(keyPortfolioClosed, state.closed || []);
}