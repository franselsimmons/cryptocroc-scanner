// /lib/_analytics.js
import { kv } from "@vercel/kv";

const TRADES_KEY = (funnel) => `cc:trades:${funnel}`;
const EVENTS_KEY = (funnel) => `cc:events:${funnel}:list`;

export function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export async function pushEvent(funnel, eventData) {
  const key = EVENTS_KEY(funnel);
  const event = {
    id: uid("evt"),
    ts: Date.now(),
    ...eventData,
  };
  // bewaar max 200 events
  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(event));
    await kv.ltrim(key, 0, 199);
  }
  return event.id;
}

export async function readTrades(funnel) {
  const key = TRADES_KEY(funnel);
  const data = await kv.get(key);
  return Array.isArray(data) ? data : [];
}

export async function writeTrades(funnel, trades) {
  const key = TRADES_KEY(funnel);
  await kv.set(key, trades);
}

export async function addPostWatch(funnel, tradeId, until) {
  // watch ttl tot 'until' (timestamp in ms)
  const key = `cc:postwatch:${funnel}:${tradeId}`;
  const ttl = Math.max(0, until - Date.now());
  await kv.set(key, { tradeId, expires: until }, { px: ttl }); // px = milliseconds
}

export function pnlPctFromPrices({ mode, entryPrice, priceNow }) {
  const e = Number(entryPrice) || 0;
  const p = Number(priceNow) || 0;
  if (!(e > 0 && p > 0)) return 0;
  if (mode === "bull") return ((p - e) / e) * 100;
  return ((e - p) / e) * 100;
}