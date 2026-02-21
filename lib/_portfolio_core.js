// /api/_portfolio_core.js
import { kv } from "@vercel/kv";

// draait overal hetzelfde als je andere endpoints
export const RUNTIME_CONFIG = { runtime: "nodejs20.x" };

// ====== auth (zelfde idee als jullie funnels) ======
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

// ====== KV keys ======
export const keyPortfolioState = "portfolio:state:v1"; // { openByKey: { [tradeKey]: trade }, closed: [] }
export const keyPortfolioClosed = "portfolio:closed:v1"; // array (backup / snel)

export function tradeKey({ funnel, mode, symbol }) {
  return `${funnel}:${mode}:${String(symbol || "").toUpperCase()}`;
}

// ====== Discord ======
export async function sendDiscordPortfolio(content) {
  const url = process.env.DISCORD_WEBHOOK_PORTFOLIO;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {
    // nooit crashen
  }
}

// ====== helpers ======
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

// “verbeter info” (alleen website) – simpele en betrouwbare dingen:
// - max winst mogelijk (peak)
// - max drawdown (trough)
// - wat ging slechter t.o.v entry (confidence/consistency/obscore)
export function buildImproveNotes(trade) {
  const side = trade?.mode;
  const entry = Number(trade?.entryPrice || 0);
  const exit = Number(trade?.exitPrice || trade?.lastPrice || 0);
  const peak = Number(trade?.peakPrice || entry);
  const trough = Number(trade?.troughPrice || entry);

  const realized = pct(entry, exit);
  const bestPossible =
    side === "bull"
      ? pct(entry, peak)
      : pct(entry, trough) * -1; // bij bear is “winst” als prijs daalt

  const dd =
    side === "bull"
      ? pct(entry, trough) // negatief
      : pct(entry, peak) * -1; // negatief “tegen je in”

  const entryConf = Number(trade?.entryMeta?.confidence || 0);
  const exitConf = Number(trade?.exitMeta?.confidence || 0);

  const entryCons = Number(trade?.entryMeta?.consistencyRatio || 0);
  const exitCons = Number(trade?.exitMeta?.consistencyRatio || 0);

  const entryOb = Number(trade?.entryMeta?.obScore || 0);
  const exitOb = Number(trade?.exitMeta?.obScore || 0);

  const lines = [];
  lines.push(`Realized PnL: ${fmt2(realized)}%`);
  lines.push(`Best possible (during trade): ${fmt2(bestPossible)}%`);
  lines.push(`Worst drawdown (during trade): ${fmt2(dd)}%`);
  lines.push(`Confidence entry→exit: ${entryConf} → ${exitConf}`);
  lines.push(`Consistency entry→exit: ${(entryCons * 100).toFixed(0)}% → ${(exitCons * 100).toFixed(0)}%`);
  lines.push(`OB score entry→exit: ${entryOb.toFixed(3)} → ${exitOb.toFixed(3)}`);

  // simpele “waarom verlies” hint
  if (realized < 0) {
    if (exitConf < entryConf - 10) lines.push("Likely reason: confidence drop.");
    if (exitCons < entryCons - 0.10) lines.push("Likely reason: consistency broke.");
    if (Math.abs(exitOb) < Math.abs(entryOb) * 0.6) lines.push("Likely reason: orderbook pressure faded.");
  }

  // simpele “hoe meer winst” hint
  if (realized > 0 && bestPossible > realized + 5) {
    lines.push("Profit note: peak was much higher than exit → consider trailing logic / partial TP.");
  }

  return lines.join("\n");
}

// Discord msg (professioneel, kort)
export function discordOpenMsg(trade) {
  const base = `📥 **OPEN** ${trade.symbol} (${trade.mode.toUpperCase()} | ${trade.funnel.toUpperCase()})`;
  const line1 = `Entry: $${trade.entryPrice} • Conf ${trade.entryMeta.confidence}/100 • Cons ${(trade.entryMeta.consistencyRatio * 100).toFixed(0)}%`;
  const link = `Open: ${trade.funnel === "moon" ? "/moon.html" : "/"}?mode=${encodeURIComponent(trade.mode)}`;
  return [base, line1, link].join("\n");
}

export function discordCloseMsg(trade) {
  const pnl = Number(trade.pnlPct || 0);
  const s = pnl >= 0 ? "+" : "";
  const base = `📤 **CLOSE** ${trade.symbol} (${trade.mode.toUpperCase()} | ${trade.funnel.toUpperCase()})`;
  const line1 = `Entry: $${trade.entryPrice} → Exit: $${trade.exitPrice} • PnL: **${s}${fmt2(pnl)}%**`;
  const line2 = `Reason: ${trade.exitReason || "left top stage"}`;
  const link = `Portfolio: /portfolio.html`;
  return [base, line1, line2, link].join("\n");
}

// load/save state
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
  // ook losse closed lijst (handig)
  await kv.set(keyPortfolioClosed, state.closed || []);
}
