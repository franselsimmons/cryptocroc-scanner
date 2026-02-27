// lib/_portfolio_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ====== auth ======
export function requireSecret(req, res) {
  const cronHeader = String(req.headers?.["x-vercel-cron"] || "").toLowerCase();
  const isVercelCron = cronHeader === "1" || cronHeader === "true";
  if (isVercelCron) return true;

  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = String(req.headers?.authorization || "");
  const token = req.query?.token ? String(req.query.token) : "";
  const ok = auth === `Bearer ${secret}` || token === secret;

  if (!ok) {
    res.statusCode = 401;
    res.setHeader?.("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

// ====== KV keys ======
export const keyPortfolioState = "portfolio:state:v1";

// ====== helpers ======
export function nowTs() {
  return Date.now();
}

export function tradeKey({ funnel, mode, symbol }) {
  const f = String(funnel || "main").toLowerCase();
  const m = String(mode || "bull").toLowerCase();
  const s = String(symbol || "").toUpperCase();
  return `${f}:${m}:${s}`;
}

// zoekt coin in latest (jouw latest heeft funnel.entry/almost/buildup/radar)
export function findCoinInLatest(latest, symbolUpper) {
  const sym = String(symbolUpper || "").toUpperCase();
  const f = latest?.funnel || {};

  const allLists = [
    ...(f.entry || []),
    ...(f.almost || []),
    ...(f.buildup || []),
    ...(f.radar || []),
    ...(f.elite || []), // moon kan elite hebben
  ];

  return allLists.find((x) => String(x?.symbol || "").toUpperCase() === sym) || null;
}

// ====== discord ======
export async function sendDiscordPortfolio(content) {
  const url = String(process.env.DISCORD_WEBHOOK_PORTFOLIO || "").trim();
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {}
}

export function discordCloseMsg(trade) {
  const sym = String(trade?.symbol || "").toUpperCase();
  const mode = String(trade?.mode || "").toUpperCase();
  const reason = String(trade?.exitReason || trade?.closeReason || "CLOSE");
  const pnl = Number(trade?.pnlPct || 0).toFixed(2);

  const entry = Number(trade?.entryPrice || 0);
  const exit = Number(trade?.exitPrice || 0);

  return `**${sym}** (${mode}) **CLOSED** • ${reason} • pnl ${pnl}% • entry $${entry} → exit $${exit}`;
}

// ====== state io ======
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
  const safe = {
    openByKey: state?.openByKey && typeof state.openByKey === "object" ? state.openByKey : {},
    closed: Array.isArray(state?.closed) ? state.closed : [],
  };
  await kv.set(keyPortfolioState, safe);
}