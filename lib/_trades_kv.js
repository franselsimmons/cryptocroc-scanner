// /api/_trades_kv.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs20.x" };

const OPEN_SET = "trades:open";
const CLOSED_SET = "trades:closed";

async function readTradeById(id) {
  return await kv.get(`trade:${id}`);
}

/**
 * Haalt alle open trades op, optioneel gefilterd op funnel.
 */
export async function readOpenTrades(limit = 500, funnel = null) {
  const ids = (await kv.smembers(OPEN_SET)) || [];
  const slice = ids.slice(0, Math.max(0, limit));
  const out = [];
  for (const id of slice) {
    const t = await readTradeById(id);
    if (t && (!funnel || t.funnel === funnel)) out.push(t);
  }
  return out;
}

/**
 * Haalt alle closed trades op, optioneel gefilterd op funnel.
 */
export async function readClosedTrades(limit = 500, funnel = null) {
  const ids = (await kv.smembers(CLOSED_SET)) || [];
  const slice = ids.slice(0, Math.max(0, limit));
  const out = [];
  for (const id of slice) {
    const t = await readTradeById(id);
    if (t && (!funnel || t.funnel === funnel)) out.push(t);
  }
  // nieuwste eerst
  out.sort((a, b) => Number(b.closedAt || 0) - Number(a.closedAt || 0));
  return out;
}

/**
 * Haalt zowel open als closed trades op, optioneel gefilterd op funnel.
 */
export async function readAllTrades(limitOpen = 500, limitClosed = 500, funnel = null) {
  const [open, closed] = await Promise.all([
    readOpenTrades(limitOpen, funnel),
    readClosedTrades(limitClosed, funnel),
  ]);
  return { open, closed, all: [...open, ...closed] };
}
