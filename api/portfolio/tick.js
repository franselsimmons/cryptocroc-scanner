// /api/portfolio/tick.js
import { kv } from "@vercel/kv";
import {
  requireSecret,
  nowTs,
  findCoinInLatest,
  sendDiscordPortfolio,
  discordCloseMsg,
  openIndexKey,
} from "../_portfolio_core.js";

export const config = { runtime: "nodejs" };

// KV keys
const keyMainLatest = (mode) => `latest:${mode}`;
const keyMoonLatest = (mode) => `moon:latest:${mode}`;

const OPEN_SET = "trades:open";
const CLOSED_SET = "trades:closed";
const LOCK_KEY = "lock:portfolio-tick";

// Betrouwbare NX-set helper
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

function pnlPctFor(mode, entry, price) {
  const e = Number(entry || 0);
  const p = Number(price || 0);
  if (!(e > 0) || !(p > 0)) return 0;
  if (mode === "bear") return ((e - p) / e) * 100;
  return ((p - e) / e) * 100;
}

function isTpHit(trade, price) {
  const p = Number(price || 0);
  if (!(p > 0)) return false;
  if (trade.mode === "bear") return p <= Number(trade.tp || 0);
  return p >= Number(trade.tp || 0);
}

function isSlHit(trade, price) {
  const p = Number(price || 0);
  if (!(p > 0)) return false;
  if (trade.mode === "bear") return p >= Number(trade.sl || 0);
  return p <= Number(trade.sl || 0);
}

function updatePerf(trade, price, now) {
  const p = Number(price || 0);
  if (!(p > 0)) return trade;

  trade.lastPrice = p;
  trade.lastPriceTs = now;

  const pnl = pnlPctFor(trade.mode, trade.entryPrice, p);
  trade.pnlPct = Number(pnl.toFixed(4));

  trade.mfePct = Math.max(Number(trade.mfePct || 0), trade.pnlPct);
  trade.maePct = Math.min(Number(trade.maePct || 0), trade.pnlPct);

  trade.peakPrice = Math.max(Number(trade.peakPrice || trade.entryPrice || 0), p);
  trade.troughPrice = Math.min(Number(trade.troughPrice || trade.entryPrice || Number.MAX_SAFE_INTEGER), p);

  return trade;
}

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  let gotLock = false;

  try {
    if (!requireSecret(req, res)) return;

    const now = nowTs();

    gotLock = await setNx(LOCK_KEY, "1", 50);
    if (!gotLock) {
      json(res, 200, { ok: true, ts: now, skipped: true, reason: "locked" });
      return;
    }

    // Latest snapshots ophalen
    const [mainBull, mainBear, moonBull, moonBear] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      kv.get(keyMoonLatest("bull")),
      kv.get(keyMoonLatest("bear")),
    ]);

    function latestForTrade(trade) {
      if (trade.funnel === "moon" && trade.mode === "bull") return moonBull;
      if (trade.funnel === "moon" && trade.mode === "bear") return moonBear;
      if (trade.mode === "bear") return mainBear;
      return mainBull;
    }

    const openIds = await kv.smembers(OPEN_SET);

    let updated = 0;
    let closed = 0;
    let stalled = 0;

    for (const id of openIds) {
      const tradeKey = `trade:${id}`;
      let trade = await kv.get(tradeKey);

      // Trade weg? haal uit set
      if (!trade) {
        await kv.srem(OPEN_SET, id);
        continue;
      }

      // Alleen OPEN/STALLED mogen in open set
      const st = String(trade.status || "").toUpperCase();
      if (st !== "OPEN" && st !== "STALLED") {
        await kv.srem(OPEN_SET, id);
        continue;
      }

      const latest = latestForTrade(trade);

      // Geen usable latest? overslaan (niet sluiten)
      if (!latest || !latest.funnel) {
        continue;
      }

      const curItem = findCoinInLatest(latest, trade.symbol);
      const price = Number(curItem?.price || 0);

      // Geen prijs => STALLED
      if (!(price > 0)) {
        trade.status = "STALLED";
        trade.lastPriceErrorAt = now;
        await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 60 });
        stalled++;
        continue;
      }

      // terug naar OPEN als hij stalled was
      if (trade.status === "STALLED") trade.status = "OPEN";

      // TP/SL moeten bestaan
      if (!(Number(trade.tp) > 0) || !(Number(trade.sl) > 0)) {
        trade.status = "STALLED";
        trade.lastPriceErrorAt = now;
        trade.error = "Missing TP/SL";
        await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 60 });
        stalled++;
        continue;
      }

      // update perf
      trade = updatePerf(trade, price, now);

      // live meta (handig in UI)
      trade.liveMeta = {
        confidence: Number(curItem?.confidence ?? 0),
        vm: Number(curItem?.vm ?? 0),
        spreadPct: Number(curItem?.ob?.spreadPct ?? 999),
        depthMinUsd1p: Number(curItem?.ob?.depthMinUsd1p ?? 0),
        obScore: Number(curItem?.ob?.score ?? 0),
        entryGate: String(curItem?.why?.entryGate ?? ""),
      };

      // hit?
      let hit = null;
      if (isTpHit(trade, price)) hit = "TP";
      else if (isSlHit(trade, price)) hit = "SL";

      if (!hit) {
        await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 60 });
        updated++;
        continue;
      }

      // CLOSE
      trade.status = "CLOSED";
      trade.closedAt = now;
      trade.exitReason = hit;
      trade.exitPrice = Number(price);
      trade.desiredExitPrice = hit === "TP" ? Number(trade.tp) : Number(trade.sl);

      // fees + net
      const feePctPerSide = Number(trade.feePctPerSide || 0.1);
      trade.feesPaidPct = Number((feePctPerSide * 2).toFixed(4));
      trade.netPnlPct = Number((Number(trade.pnlPct || 0) - trade.feesPaidPct).toFixed(4));

      // holding time
      trade.holdingTimeSec = Math.floor((now - Number(trade.openedAt || trade.tsOpen || now)) / 1000);

      // opslaan 1 jaar
      await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 365 });

      // sets bijwerken
      await kv.srem(OPEN_SET, id);
      await kv.sadd(CLOSED_SET, id);

      // open index key weg (zodat scan weer nieuwe kan openen)
      await kv.del(openIndexKey({ funnel: trade.funnel, mode: trade.mode, symbol: trade.symbol }));

      // discord
      await sendDiscordPortfolio(discordCloseMsg(trade));

      closed++;
    }

    json(res, 200, {
      ok: true,
      ts: now,
      openChecked: openIds.length,
      updated,
      closed,
      stalled,
    });
  } catch (e) {
    json(res, 200, { ok: false, error: String(e?.message || e) });
  } finally {
    // lock altijd opruimen
    if (gotLock) {
      try {
        await kv.del(LOCK_KEY);
      } catch {}
    }
  }
}