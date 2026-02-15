// /api/portfolio-tick.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  loadPortfolioState,
  savePortfolioState,
  tradeKey,
  nowTs,
  pct,
  fmt2,
  findCoinInLatest,
  listTop,
  buildImproveNotes,
  sendDiscordPortfolio,
  discordOpenMsg,
  discordCloseMsg,
} from "./_portfolio_core.js";

export const config = RUNTIME_CONFIG;

// Jullie bestaande KV latest keys:
const keyMainLatest = (mode) => `latest:${mode}`;      // main funnel
const keyMoonLatest = (mode) => `moon:latest:${mode}`; // moon funnel

function extractMetaFromItem(item) {
  const consRatio = Number(item?.consistency?.ratio || 0);
  const obScore = Number(item?.ob?.score ?? 0);
  const obValid = !!item?.ob?.valid;
  const spread = Number(item?.ob?.spreadPct ?? 999);

  return {
    confidence: Number(item?.confidence || 0),
    consistencyRatio: consRatio,
    obScore: obScore,
    obValid: obValid,
    spreadPct: spread,
    vm: Number(item?.vm || 0),
    volAcc: Number(item?.volAcc || 0),
  };
}

function updatePeaks(trade, curPrice) {
  const p = Number(curPrice || 0);
  if (!(p > 0)) return trade;

  trade.lastPrice = p;

  if (!(trade.peakPrice > 0)) trade.peakPrice = p;
  if (!(trade.troughPrice > 0)) trade.troughPrice = p;

  // bull: peak = hoogste, trough = laagste
  // bear: peak/trough houden we ook bij (voor drawdown + best move)
  trade.peakPrice = Math.max(Number(trade.peakPrice || p), p);
  trade.troughPrice = Math.min(Number(trade.troughPrice || p), p);

  return trade;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const now = nowTs();

    // lees latest snapshots
    const mainBull = await kv.get(keyMainLatest("bull"));
    const mainBear = await kv.get(keyMainLatest("bear"));
    const moonBull = await kv.get(keyMoonLatest("bull"));
    const moonBear = await kv.get(keyMoonLatest("bear"));

    const state = await loadPortfolioState();

    // helper: open trades uit top list
    async function processOpen({ funnel, mode, latest }) {
      const top = listTop(latest, funnel);

      for (const item of top) {
        const symbol = String(item?.symbol || "").toUpperCase();
        if (!symbol) continue;

        const k = tradeKey({ funnel, mode, symbol });
        if (state.openByKey[k]) {
          // update live stats (peak/trough)
          state.openByKey[k] = updatePeaks(state.openByKey[k], item?.price);
          state.openByKey[k].liveMeta = extractMetaFromItem(item);
          continue;
        }

        // OPEN nieuwe trade
        const entryPrice = Number(item?.price || 0);
        if (!(entryPrice > 0)) continue;

        const trade = {
          id: `${now}:${k}`,
          tsOpen: now,
          funnel,
          mode,           // bull/bear
          symbol,

          status: "OPEN",
          entryPrice: Number(entryPrice.toFixed(8)),
          lastPrice: Number(entryPrice.toFixed(8)),
          peakPrice: Number(entryPrice.toFixed(8)),
          troughPrice: Number(entryPrice.toFixed(8)),

          entryMeta: extractMetaFromItem(item),
          liveMeta: extractMetaFromItem(item),

          exitReason: null,
          exitPrice: null,
          tsClose: null,
          pnlPct: null,

          improveNotes: null, // pas vullen bij close
        };

        state.openByKey[k] = trade;

        // Discord OPEN
        await sendDiscordPortfolio(discordOpenMsg(trade));
      }
    }

    // helper: close trades die niet meer in top zitten
    async function processClose({ funnel, mode, latest }) {
      const openKeys = Object.keys(state.openByKey);
      for (const k of openKeys) {
        const t = state.openByKey[k];
        if (!t || t.status !== "OPEN") continue;
        if (t.funnel !== funnel || t.mode !== mode) continue;

        // kijk of coin nog in top stage staat
        const topList = listTop(latest, funnel);
        const stillTop = topList.some((x) => String(x?.symbol || "").toUpperCase() === t.symbol);

        // bepaal “current item” (prijs/metrics) ook als hij is teruggevallen naar ALMOST/BUILDUP
        const curItem = findCoinInLatest(latest, t.symbol);

        if (stillTop) {
          // live update
          if (curItem?.price) state.openByKey[k] = updatePeaks(t, curItem.price);
          state.openByKey[k].liveMeta = extractMetaFromItem(curItem || {});
          continue;
        }

        // CLOSE
        const exitPrice = Number(curItem?.price || t.lastPrice || t.entryPrice || 0);
        const pnl = pct(t.entryPrice, exitPrice);

        const exitMeta = extractMetaFromItem(curItem || {});
        const reason = curItem
          ? `left ${funnel === "moon" ? "ELITE" : "ENTRY"} → now ${String(curItem.stage || "lower stage")}`
          : `left ${funnel === "moon" ? "ELITE" : "ENTRY"} (no current data)`;

        const closed = {
          ...t,
          status: "CLOSED",
          tsClose: now,
          exitPrice: Number(exitPrice.toFixed(8)),
          pnlPct: Number(pnl.toFixed(4)),
          exitReason: reason,
          exitMeta,
        };

        closed.improveNotes = buildImproveNotes(closed);

        // opslaan
        delete state.openByKey[k];
        state.closed.unshift(closed);
        state.closed = state.closed.slice(0, 400); // max 400 trades bewaren

        // Discord CLOSE
        await sendDiscordPortfolio(discordCloseMsg(closed));
      }
    }

    // === run order ===
    await processOpen({ funnel: "main", mode: "bull", latest: mainBull });
    await processOpen({ funnel: "main", mode: "bear", latest: mainBear });
    await processOpen({ funnel: "moon", mode: "bull", latest: moonBull });
    await processOpen({ funnel: "moon", mode: "bear", latest: moonBear });

    await processClose({ funnel: "main", mode: "bull", latest: mainBull });
    await processClose({ funnel: "main", mode: "bear", latest: mainBear });
    await processClose({ funnel: "moon", mode: "bull", latest: moonBull });
    await processClose({ funnel: "moon", mode: "bear", latest: moonBear });

    await savePortfolioState(state);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      ts: now,
      open: Object.keys(state.openByKey).length,
      closed: state.closed.length
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}
