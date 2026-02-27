// /api/_portfolio_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ===== auth =====
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
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

export function nowTs() {
  return Date.now();
}

export function openIndexKey({ funnel, mode, symbol }) {
  return `open:${String(funnel || "main")}:${String(mode || "bull")}:${String(symbol || "").toUpperCase()}`;
}

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

function fmtPct(p) {
  const n = Number(p || 0);
  const s = n >= 0 ? "+" : "";
  return `${s}${n.toFixed(2)}%`;
}

function usd6(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "0.000000";
  return v.toFixed(6);
}

export function discordCloseMsg(trade) {
  const sym = String(trade?.symbol || "—").toUpperCase();
  const mode = String(trade?.mode || "bull").toUpperCase();
  const funnel = String(trade?.funnel || "main").toUpperCase();

  const pnl = Number(trade?.pnlPct || 0);
  const net = Number(trade?.netPnlPct ?? pnl);

  const reason = String(trade?.exitReason || trade?.closeReason || "CLOSE");
  const entry = usd6(trade?.entryPrice);
  const exit = usd6(trade?.exitPrice);

  return `**${sym}** • ${funnel} • ${mode}\n` +
    `**CLOSED** (${reason}) • pnl ${fmtPct(pnl)} • net ${fmtPct(net)}\n` +
    `entry $${entry} → exit $${exit}`;
}

// zoekt coin in latest snapshot (entry/almost/buildup/radar + evt hold/sell)
export function findCoinInLatest(latest, symbolUpper) {
  const sym = String(symbolUpper || "").toUpperCase();
  const f = latest?.funnel || {};

  const allLists = []
    .concat(f.entry || [])
    .concat(f.almost || [])
    .concat(f.buildup || [])
    .concat(f.radar || []);

  // als jij ooit elite/moon gebruikt:
  if (Array.isArray(f.elite)) allLists.push(...f.elite);

  return allLists.find((x) => String(x?.symbol || "").toUpperCase() === sym) || null;
}