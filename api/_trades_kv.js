// /api/_trades_kv.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs20.x" };

const OPEN_SET = "trades:open";
const CLOSED_SET = "trades:closed";

async function readTradeById(id) {
  return await kv.get(`trade:${id}`);
}

export async function readOpenTrades(limit = 500) {
  const ids = (await kv.smembers(OPEN_SET)) || [];
  const slice = ids.slice(0, Math.max(0, limit));
  const out = [];
  for (const id of slice) {
    const t = await readTradeById(id);
    if (t) out.push(t);
  }
  return out;
}

export async function readClosedTrades(limit = 500) {
  const ids = (await kv.smembers(CLOSED_SET)) || [];
  const slice = ids.slice(0, Math.max(0, limit));
  const out = [];
  for (const id of slice) {
    const t = await readTradeById(id);
    if (t) out.push(t);
  }
  // newest first
  out.sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0));
  return out;
}

export async function readAllTrades(limitOpen = 500, limitClosed = 500) {
  const [open, closed] = await Promise.all([
    readOpenTrades(limitOpen),
    readClosedTrades(limitClosed),
  ]);
  return { open, closed, all: [...open, ...closed] };
}