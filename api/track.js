import { kv } from "@vercel/kv";
import { requireSecret } from "../lib/_core_bull.js";

// ✅ JOUW files staan in /lib, niet in /api
import { readAllTrades } from "../lib/_trades_kv.js";
import {
  readPostWatch, writePostWatch, addPostWatch,
  fetchCgPriceUsdByIds, pnlPctFromPrices, hitSlTp, pushEvent, nowMs
} from "../lib/_analytics.js";

export const config = { runtime: "nodejs" };

const TTL_MAIN_HOURS = 72;
const TTL_MOON_HOURS = 48;
const POST_WATCH_HOURS = 24;
const BATCH_IDS = 200;

const OPEN_SET = "trades:open";
const CLOSED_SET = "trades:closed";

function n(x){ const v=Number(x); return Number.isFinite(v)?v:0; }

function mfeMaeUpdate(trade, priceNow) {
  const pnl = pnlPctFromPrices({ mode: trade.mode, entryPrice: trade.entryPrice, priceNow });
  trade.pnlPct = +n(pnl).toFixed(2);
  trade.mfePct = trade.mfePct == null ? trade.pnlPct : Math.max(n(trade.mfePct), trade.pnlPct);
  trade.maePct = trade.maePct == null ? trade.pnlPct : Math.min(n(trade.maePct), trade.pnlPct);
}

function postUpdate(trade, priceNow) {
  const base = n(trade.exitPrice || trade.entryPrice);
  if (!(base > 0 && n(priceNow) > 0)) return;

  const mode = String(trade.mode);
  const movePct = mode === "bull"
    ? ((priceNow - base) / base) * 100
    : ((base - priceNow) / base) * 100;

  const p = +n(movePct).toFixed(2);
  trade.postBestPct = trade.postBestPct == null ? p : Math.max(n(trade.postBestPct), p);
  trade.postWorstPct = trade.postWorstPct == null ? p : Math.min(n(trade.postWorstPct), p);
}

function openIndexKey({ funnel, mode, symbol }) {
  return `open:${funnel}:${mode}:${String(symbol || "").toUpperCase()}`;
}

async function saveTrade(trade) {
  await kv.set(`trade:${trade.id}`, trade, { ex: 60 * 60 * 24 * 365 });
}

async function trackFunnel(funnel) {
  const now = nowMs();
  const ttlMs = (funnel === "main" ? TTL_MAIN_HOURS : TTL_MOON_HOURS) * 60 * 60 * 1000;

  const { open, closed } = await readAllTrades(500, 500, funnel);
  const trades = [...open, ...closed];

  const openTrades = open.filter(t => String(t.status) === "OPEN");
  const openIds = openTrades.map(t => t.cgId);

  for (let i=0;i<openIds.length;i+=BATCH_IDS) {
    const slice = openIds.slice(i, i+BATCH_IDS);
    const pxMap = await fetchCgPriceUsdByIds(slice);

    for (const t of openTrades) {
      if (!slice.includes(t.cgId)) continue;
      const px = pxMap.get(t.cgId);
      if (!(px > 0)) continue;

      t.lastPrice = +px;
      mfeMaeUpdate(t, px);

      const hit = hitSlTp({ mode: t.mode, priceNow: px, sl: t.sl, tp: t.tp });
      const tooOld = (now - n(t.openedAt)) > ttlMs;

      if (hit.hit || tooOld) {
        t.status = "CLOSED";
        t.closedAt = now;
        t.exitPrice = +px;
        t.exitReason = hit.hit ? hit.kind : "TTL";

        await kv.srem(OPEN_SET, t.id);
        await kv.sadd(CLOSED_SET, t.id);
        await kv.del(openIndexKey({ funnel: t.funnel, mode: t.mode, symbol: t.symbol }));

        const until = now + POST_WATCH_HOURS * 60 * 60 * 1000;
        await addPostWatch(funnel, t.id, until);

        await pushEvent(funnel, {
          ts: now,
          funnel,
          mode: t.mode,
          symbol: t.symbol,
          type: "TRADE_CLOSE",
          reason: t.exitReason,
          pnlPct: t.pnlPct,
        });
      }

      await saveTrade(t);
    }
  }

  let post = await readPostWatch(funnel);
  post = post.filter(x => n(x?.untilTs) > now);

  const watchIds = post.map(x => {
    const tr = trades.find(t => String(t.id) === String(x.id));
    return tr?.cgId || null;
  }).filter(Boolean);

  for (let i=0;i<watchIds.length;i+=BATCH_IDS) {
    const slice = watchIds.slice(i, i+BATCH_IDS);
    const pxMap = await fetchCgPriceUsdByIds(slice);

    for (const w of post) {
      const t = trades.find(tt => String(tt.id) === String(w.id));
      if (!t) continue;
      const px = pxMap.get(t.cgId);
      if (!(px > 0)) continue;

      postUpdate(t, px);
      await saveTrade(t);
    }
  }

  post = post.filter(x => n(x?.untilTs) > now);
  await writePostWatch(funnel, post);

  return { funnel, open: openTrades.length, closedTotal: closed.length, postWatching: post.length };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;
    const r1 = await trackFunnel("main");
    const r2 = await trackFunnel("moon");
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok:true, ts: Date.now(), main: r1, moon: r2 }));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok:false, error: String(e?.message || e) }));
  }
}