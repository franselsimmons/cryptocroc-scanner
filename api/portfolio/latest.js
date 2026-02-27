// /api/portfolio/latest.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// KV sets
const OPEN_SET = "trades:open";
const CLOSED_SET = "trades:closed";

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function isObj(x) {
  return x && typeof x === "object";
}

async function getTradesFromIds(ids, max = 250) {
  const list = [];
  const slice = safeArr(ids).slice(0, Math.max(0, max));

  // simpel & veilig (weinig ids): 1 voor 1
  for (const id of slice) {
    const t = await kv.get(`trade:${id}`);
    if (isObj(t)) list.push({ id, ...t });
  }
  return list;
}

export default async function handler(req, res) {
  try {
    const [openIdsRaw, closedIdsRaw] = await Promise.all([
      kv.smembers(OPEN_SET),
      kv.smembers(CLOSED_SET),
    ]);

    const openTrades = await getTradesFromIds(openIdsRaw, 400);
    const closedTrades = await getTradesFromIds(closedIdsRaw, 400);

    // Alleen echte OPEN in open lijst (STALLED mag ook als je wil)
    const open = openTrades
      .filter((t) => {
        const st = String(t?.status || "").toUpperCase();
        return st === "OPEN" || st === "STALLED";
      })
      .sort((a, b) => Number(b?.openedAt || 0) - Number(a?.openedAt || 0));

    // Alleen CLOSED in closed lijst
    const closed = closedTrades
      .filter((t) => String(t?.status || "").toUpperCase() === "CLOSED")
      .sort((a, b) => Number(b?.closedAt || 0) - Number(a?.closedAt || 0))
      .slice(0, 250);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(
      JSON.stringify({
        ok: true,
        ts: Date.now(),
        open,
        closed,
      })
    );
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}