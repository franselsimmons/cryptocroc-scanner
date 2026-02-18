// /api/track.js
import { RUNTIME_CONFIG, requireSecret } from "./_core.js";
import {
  readTrades, writeTrades, readPostWatch, writePostWatch, addPostWatch,
  fetchCgPriceUsdByIds, pnlPctFromPrices, hitSlTp, pushEvent, nowMs
} from "./_analytics.js";

export const config = RUNTIME_CONFIG;

const TTL_MAIN_HOURS = 72;     // MAIN: max 3 dagen
const TTL_MOON_HOURS = 48;     // MOON: sneller
const POST_WATCH_HOURS = 24;   // na close nog 24u volgen
const BATCH_IDS = 200;

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

async function trackFunnel(funnel) {
  const now = nowMs();
  const ttlMs = (funnel === "main" ? TTL_MAIN_HOURS : TTL_MOON_HOURS) * 60 * 60 * 1000;

  let trades = await readTrades(funnel);
  trades = trades.filter(t => t && t.id && t.cgId);

  const open = trades.filter(t => String(t.status) === "OPEN");
  const openIds = open.map(t => t.cgId);

  for (let i=0;i<openIds.length;i+=BATCH_IDS) {
    const slice = openIds.slice(i, i+BATCH_IDS);
    const pxMap = await fetchCgPriceUsdByIds(slice);

    for (const t of open) {
      if (!slice.includes(t.cgId)) continue;
      const px = pxMap.get(t.cgId);
      if (!(px > 0)) continue;

      t.lastPrice = +px;
      mfeMaeUpdate(t, px);

      const hit = hitSlTp({ mode: t.mode, priceNow: px, sl: t.sl, tp: t.tp });
      const tooOld = (now - n(t.entryAt)) > ttlMs;

      if (hit.hit || tooOld) {
        t.status = "CLOSED";
        t.exitAt = now;
        t.exitPrice = +px;

        if (hit.hit) t.exitReason = hit.kind;  // TP/SL
        else t.exitReason = "TTL";             // time-out

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
    }
  }

  // POST WATCH
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
    }
  }

  post = post.filter(x => n(x?.untilTs) > now);
  await writePostWatch(funnel, post);
  await writeTrades(funnel, trades);

  return {
    funnel,
    open: open.length,
    closedTotal: trades.filter(t => String(t.status) === "CLOSED").length,
    postWatching: post.length,
  };
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