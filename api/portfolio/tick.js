// api/portfolio/tick.js
import { kv } from "@vercel/kv";
import {
  requireSecret,
  nowTs,
  loadPortfolioState,
  savePortfolioState,
  findCoinInLatest,
  sendDiscordPortfolio,
  discordCloseMsg,
  tradeKey,
} from "../../lib/_portfolio_core.js";

export const config = { runtime: "nodejs" };

const LOCK_KEY = "lock:portfolio:tick";
const LOCK_EX_SEC = 55;

// latest snapshots (jouw bestaande keys)
const keyMainLatest = (mode) => `latest:${String(mode || "bull").toLowerCase()}`;
const keyMoonLatest = (mode) => `moon:latest:${String(mode || "bull").toLowerCase()}`;

async function setNx(key, value, exSec) {
  if (typeof kv.setnx === "function") {
    const ok = await kv.setnx(key, value);
    if (ok) await kv.expire(key, exSec);
    return !!ok;
  }
  const exists = await kv.get(key);
  if (exists) return false;
  await kv.set(key, value, { ex: exSec });
  return true;
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function pnlPctFor(mode, entry, price) {
  const e = n(entry, 0);
  const p = n(price, 0);
  if (!(e > 0) || !(p > 0)) return 0;
  if (String(mode).toLowerCase() === "bear") return ((e - p) / e) * 100;
  return ((p - e) / e) * 100;
}

function isTpHit(trade, price) {
  const p = n(price, 0);
  const tp = n(trade?.tp, 0);
  if (!(p > 0) || !(tp > 0)) return false;
  if (String(trade.mode).toLowerCase() === "bear") return p <= tp;
  return p >= tp;
}

function isSlHit(trade, price) {
  const p = n(price, 0);
  const sl = n(trade?.sl, 0);
  if (!(p > 0) || !(sl > 0)) return false;
  if (String(trade.mode).toLowerCase() === "bear") return p >= sl;
  return p <= sl;
}

function latestForTrade({ trade, mainBull, mainBear, moonBull, moonBear }) {
  const m = String(trade?.mode || "bull").toLowerCase();
  const f = String(trade?.funnel || "main").toLowerCase();
  if (f === "moon" && m === "bull") return moonBull;
  if (f === "moon" && m === "bear") return moonBear;
  if (m === "bear") return mainBear;
  return mainBull;
}

function updatePeaks(trade, price) {
  const p = n(price, 0);
  if (!(p > 0)) return trade;

  const peak = n(trade.peakPrice, 0);
  const trough = n(trade.troughPrice, 0);

  trade.peakPrice = peak > 0 ? Math.max(peak, p) : p;
  trade.troughPrice = trough > 0 ? Math.min(trough, p) : p;

  return trade;
}

export default async function handler(req, res) {
  let gotLock = false;

  try {
    if (!requireSecret(req, res)) return;

    const now = nowTs();

    gotLock = await setNx(LOCK_KEY, "1", LOCK_EX_SEC);
    if (!gotLock) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ ok: true, ts: now, skipped: true, reason: "locked" }));
      return;
    }

    // snapshots
    const [mainBull, mainBear, moonBull, moonBear] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      kv.get(keyMoonLatest("bull")),
      kv.get(keyMoonLatest("bear")),
    ]);

    const state = await loadPortfolioState();
    const openByKey = state.openByKey || {};
    const closedArr = Array.isArray(state.closed) ? state.closed : [];

    let openChecked = 0;
    let updated = 0;
    let closed = 0;
    let stalled = 0;

    for (const [k, t0] of Object.entries(openByKey)) {
      const trade = t0 && typeof t0 === "object" ? { ...t0 } : null;
      if (!trade) {
        delete openByKey[k];
        continue;
      }

      if (String(trade.status).toUpperCase() !== "OPEN" && String(trade.status).toUpperCase() !== "STALLED") {
        delete openByKey[k];
        continue;
      }

      openChecked++;

      const latest = latestForTrade({ trade, mainBull, mainBear, moonBull, moonBear });
      if (!latest) continue;

      const curItem = findCoinInLatest(latest, trade.symbol);
      const price = n(curItem?.price, 0);

      if (!(price > 0)) {
        trade.status = "STALLED";
        trade.lastPriceErrorAt = now;
        openByKey[k] = trade;
        stalled++;
        continue;
      }

      // back to OPEN if stalled
      trade.status = "OPEN";

      trade.lastPrice = price;
      trade.lastPriceTs = now;
      trade.pnlPct = Number(pnlPctFor(trade.mode, trade.entryPrice, price).toFixed(4));

      // peaks/troughs
      updatePeaks(trade, price);

      // liveMeta (handig voor tuning)
      trade.liveMeta = {
        confidence: n(curItem?.confidence, n(trade?.entryMeta?.confidence, 0)),
        vm: n(curItem?.vm, 0),
        spreadPct: n(curItem?.ob?.spreadPct, 999),
        obScore: n(curItem?.ob?.score, 0),
      };

      // TP/SL guard
      if (!(n(trade.tp, 0) > 0) || !(n(trade.sl, 0) > 0)) {
        trade.status = "STALLED";
        trade.error = "Missing TP/SL";
        trade.lastPriceErrorAt = now;
        openByKey[k] = trade;
        stalled++;
        continue;
      }

      let hit = null;
      if (isTpHit(trade, price)) hit = "TP";
      else if (isSlHit(trade, price)) hit = "SL";

      if (!hit) {
        openByKey[k] = trade;
        updated++;
        continue;
      }

      // CLOSE
      trade.status = "CLOSED";
      trade.closedAt = now;
      trade.exitPrice = price;
      trade.exitReason = hit;

      // slippage vs desired exit level
      trade.desiredExitPrice = hit === "TP" ? n(trade.tp, 0) : n(trade.sl, 0);
      if (trade.desiredExitPrice > 0 && n(trade.entryPrice, 0) > 0) {
        const rawSlip =
          String(trade.mode).toLowerCase() === "bear"
            ? ((trade.desiredExitPrice - trade.exitPrice) / trade.entryPrice) * 100
            : ((trade.exitPrice - trade.desiredExitPrice) / trade.entryPrice) * 100;
        trade.slippagePct = Number(rawSlip.toFixed(4));
      } else {
        trade.slippagePct = null;
      }

      // fees (optioneel)
      const feePctPerSide = n(trade.feePctPerSide, 0.10);
      trade.feesPaidPct = Number((feePctPerSide * 2).toFixed(4));
      trade.netPnlPct = Number((n(trade.pnlPct, 0) - n(trade.feesPaidPct, 0)).toFixed(4));

      // holding time
      trade.holdingTimeSec = Math.floor((now - n(trade.openedAt, now)) / 1000);

      // move to closed
      closedArr.push(trade);
      delete openByKey[k];

      // discord
      try {
        await sendDiscordPortfolio(discordCloseMsg(trade));
      } catch {}

      closed++;
    }

    // keep last 500 closed
    state.openByKey = openByKey;
    state.closed = closedArr.slice(-500);

    await savePortfolioState(state);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(
      JSON.stringify({
        ok: true,
        ts: now,
        openChecked,
        updated,
        closed,
        stalled,
        openKeys: Object.keys(openByKey).length,
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  } finally {
    if (gotLock) {
      try {
        await kv.del(LOCK_KEY);
      } catch {}
    }
  }
}