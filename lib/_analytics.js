// /lib/_analytics.js
import { kv } from "@vercel/kv";

const NS = "cc:analytics";

function keyTrades(funnel) {
  return `${NS}:trades:${String(funnel || "main")}`;
}
function keyEvents(funnel) {
  return `${NS}:events:${String(funnel || "main")}`;
}
function keyPostWatch(funnel) {
  return `${NS}:postwatch:${String(funnel || "main")}`;
}

export function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

export async function readTrades(funnel) {
  const t = await kv.get(keyTrades(funnel));
  return Array.isArray(t) ? t : [];
}

export async function writeTrades(funnel, trades) {
  const arr = Array.isArray(trades) ? trades : [];
  await kv.set(keyTrades(funnel), arr);
}

export async function pushEvent(funnel, ev) {
  const arr = (await kv.get(keyEvents(funnel))) || [];
  const list = Array.isArray(arr) ? arr : [];
  list.push({ ...ev, ts: Number(ev?.ts || Date.now()) });
  while (list.length > 400) list.shift();
  await kv.set(keyEvents(funnel), list);
}

export async function addPostWatch(funnel, tradeId, untilTs) {
  const raw = (await kv.get(keyPostWatch(funnel))) || {};
  const obj = raw && typeof raw === "object" ? raw : {};
  obj[String(tradeId)] = Number(untilTs || Date.now());
  await kv.set(keyPostWatch(funnel), obj);
}

// helper voor PnL in scan.js mirror
export function pnlPctFromPrices({ mode, entryPrice, priceNow }) {
  const e = Number(entryPrice || 0);
  const p = Number(priceNow || 0);
  if (!(e > 0 && p > 0)) return 0;
  if (mode === "bull") return ((p - e) / e) * 100;
  return ((e - p) / e) * 100;
}

// (optioneel) later kun je hier “post-watch outcomes” bouwen
export function addPostWatchOutcomeStub() {
  return;
}