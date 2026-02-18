// /api/_analytics.js
import { kv } from "@vercel/kv";

// ===== KV KEYS =====
export const keyTrades = (funnel) => `trades:${String(funnel || "main")}`; // array of trades
export const keyEvents = (funnel) => `events:${String(funnel || "main")}`; // list (LPUSH) of events
export const keyPostWatch = (funnel) => `postwatch:${String(funnel || "main")}`; // array of {id, untilTs}

// ===== HELPERS =====
export function safeArr(x) { return Array.isArray(x) ? x : []; }
export function nowMs() { return Date.now(); }

export function uid(prefix="t") {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export async function pushEvent(funnel, ev) {
  try {
    const payload = JSON.stringify(ev);
    if (typeof kv.lpush === "function") {
      await kv.lpush(keyEvents(funnel), payload);
      if (typeof kv.ltrim === "function") await kv.ltrim(keyEvents(funnel), 0, 40000);
    } else {
      await kv.set(`event:${funnel}:${ev.ts}:${ev.symbol}:${ev.to || "?"}`, ev, { ex: 60 * 60 * 24 * 60 });
    }
  } catch {}
}

export async function readEvents(funnel, max=40000) {
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyEvents(funnel), 0, Math.min(max, 40000) - 1);
      return safeArr(raw).map(x => {
        try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; }
      }).filter(Boolean);
    }
  } catch {}
  return [];
}

export async function readTrades(funnel) {
  try {
    return safeArr(await kv.get(keyTrades(funnel)));
  } catch {
    return [];
  }
}

export async function writeTrades(funnel, trades) {
  try {
    await kv.set(keyTrades(funnel), safeArr(trades).slice(-20000));
  } catch {}
}

export async function upsertTrade(funnel, trade) {
  const list = await readTrades(funnel);
  const id = String(trade.id || "");
  const idx = list.findIndex(t => String(t?.id) === id);
  if (idx >= 0) list[idx] = trade;
  else list.push(trade);
  await writeTrades(funnel, list);
}

export async function addPostWatch(funnel, id, untilTs) {
  const arr = await readPostWatch(funnel);
  const next = arr.filter(x => String(x?.id) !== String(id));
  next.push({ id, untilTs: Number(untilTs || 0) });
  await kv.set(keyPostWatch(funnel), next.slice(-20000));
}

export async function readPostWatch(funnel) {
  try {
    return safeArr(await kv.get(keyPostWatch(funnel)));
  } catch {
    return [];
  }
}

export async function writePostWatch(funnel, list) {
  try {
    await kv.set(keyPostWatch(funnel), safeArr(list).slice(-20000));
  } catch {}
}

// ===== PRICE FETCH =====
export async function fetchCgPriceUsdByIds(ids) {
  const uniq = [...new Set(safeArr(ids).map(x => String(x||"").trim()).filter(Boolean))].slice(0, 250);
  if (!uniq.length) return new Map();

  const url =
    `https://api.coingecko.com/api/v3/simple/price?` +
    `ids=${encodeURIComponent(uniq.join(","))}&vs_currencies=usd`;

  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return new Map();
    const j = await r.json();
    const map = new Map();
    for (const id of uniq) {
      const px = Number(j?.[id]?.usd || 0);
      if (px > 0) map.set(id, px);
    }
    return map;
  } catch {
    return new Map();
  }
}

export function pnlPctFromPrices({ mode, entryPrice, priceNow }) {
  const e = Number(entryPrice || 0);
  const p = Number(priceNow || 0);
  if (!(e > 0 && p > 0)) return 0;
  if (mode === "bull") return ((p - e) / e) * 100;
  return ((e - p) / e) * 100;
}

export function hitSlTp({ mode, priceNow, sl, tp }) {
  const p = Number(priceNow || 0);
  if (!(p > 0)) return { hit:false };

  const SL = Number(sl || 0);
  const TP = Number(tp || 0);

  if (mode === "bull") {
    if (SL && p <= SL) return { hit:true, kind:"SL" };
    if (TP && p >= TP) return { hit:true, kind:"TP" };
  } else {
    if (SL && p >= SL) return { hit:true, kind:"SL" };
    if (TP && p <= TP) return { hit:true, kind:"TP" };
  }
  return { hit:false };
}