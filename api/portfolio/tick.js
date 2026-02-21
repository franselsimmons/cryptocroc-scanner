// /api/portfolio-tick.js
import { kv } from "@vercel/kv";
import {
  requireSecret,
  nowTs,
  findCoinInLatest,
  sendDiscordPortfolio,
  discordCloseMsg,
} from "./_portfolio_core.js";

export const config = { runtime: "nodejs20.x" };

// KV keys
const keyMainLatest = (mode) => `latest:${mode}`;
const keyMoonLatest = (mode) => `moon:latest:${mode}`;
const OPEN_SET = "trades:open";
const CLOSED_SET = "trades:closed";
const LOCK_KEY = "lock:portfolio-tick";

// Betrouwbare NX-set helper (zelfde als in scan.js)
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

function openIndexKey({ funnel, mode, symbol }) {
  return `open:${funnel}:${mode}:${String(symbol || "").toUpperCase()}`;
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
  trade.lastValidPrice = p;

  const pnl = pnlPctFor(trade.mode, trade.entryPrice, p);
  trade.pnlPct = Number(pnl.toFixed(4));

  trade.mfePct = Math.max(Number(trade.mfePct || 0), trade.pnlPct);
  trade.maePct = Math.min(Number(trade.maePct || 0), trade.pnlPct);

  if (trade.mfePct > 0) {
    const giveback = trade.mfePct - trade.pnlPct;
    trade.maxGivebackPct = Math.max(Number(trade.maxGivebackPct || 0), Number(giveback.toFixed(4)));

    // giveback trail
    const trig = Number(trade.givebackTrailTriggerPct || 0);
    if (trade.givebackTrailEnabled && trig > 0 && giveback >= trig && trade.pnlPct > 0) {
      const be = Number(trade.entryPrice || 0);
      if (trade.mode === "bull") {
        if (trade.sl < be) {
          trade.sl = be;
          trade.trailingActive = true;
          trade.trailingStop = be;
          trade.trailingActivatedAt = now;
        }
      } else {
        if (trade.sl > be) {
          trade.sl = be;
          trade.trailingActive = true;
          trade.trailingStop = be;
          trade.trailingActivatedAt = now;
        }
      }
    }
  }

  return trade;
}

// Helper voor JSON response (Vercel Node handler)
function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const now = nowTs();

    // Lock met setNx (betrouwbaar)
    const gotLock = await setNx(LOCK_KEY, "1", 50);
    if (!gotLock) {
      json(res, 200, { ok: true, ts: now, skipped: true, reason: "locked" });
      return;
    }

    // Latest snapshots ophalen
    const mainBull = await kv.get(keyMainLatest("bull"));
    const mainBear = await kv.get(keyMainLatest("bear"));
    const moonBull = await kv.get(keyMoonLatest("bull"));
    const moonBear = await kv.get(keyMoonLatest("bear"));

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
      
      // Als trade niet bestaat, uit set verwijderen
      if (!trade) {
        await kv.srem(OPEN_SET, id);
        continue;
      }

      // Alleen OPEN en STALLED mogen in de set blijven; andere statussen verwijderen
      if (trade.status !== "OPEN" && trade.status !== "STALLED") {
        await kv.srem(OPEN_SET, id);
        continue;
      }

      const latest = latestForTrade(trade);
      // ✅ Juiste check: latest moet een geldige snapshot zijn met funnel.entry array
      if (!latest || !latest.funnel || !latest.funnel.entry) {
        // Geen bruikbare data, gewoon overslaan (geen STALLED)
        continue;
      }

      const curItem = findCoinInLatest(latest, trade.symbol);
      const price = Number(curItem?.price || 0);

      // Geen geldige prijs -> STALLED
      if (!(price > 0)) {
        trade.status = "STALLED";
        trade.lastPriceErrorAt = now;
        await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 60 });
        stalled++;
        continue;
      }

      // Als hij stalled was, terug naar OPEN
      if (trade.status === "STALLED") trade.status = "OPEN";

      // Extra check: TP/SL moeten bestaan, anders STALLED
      if (!(Number(trade.tp) > 0) || !(Number(trade.sl) > 0)) {
        trade.status = "STALLED";
        trade.lastPriceErrorAt = now;
        trade.error = "Missing TP/SL";
        await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 60 });
        stalled++;
        continue;
      }

      // Prestatie-update
      trade = updatePerf(trade, price, now);

      // Live meta (optioneel)
      trade.liveMeta = {
        confidence: Number(curItem?.confidence || trade.entryMeta?.confidence || 0),
        vm: Number(curItem?.vm || 0),
        spreadPct: Number(curItem?.ob?.spreadPct ?? 999),
        obScore: Number(curItem?.ob?.score ?? 0),
      };

      // TP/SL check
      let hit = null;
      if (isTpHit(trade, price)) hit = "TP";
      else if (isSlHit(trade, price)) hit = "SL";

      if (!hit) {
        // Geen hit, gewoon opslaan
        await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 60 });
        updated++;
        continue;
      }

      // CLOSE trade
      trade.status = "CLOSED";
      trade.closedAt = now;
      trade.closeReason = hit;
      trade.exitPrice = Number(price);

      // desiredExitPrice (TP/SL level)
      trade.desiredExitPrice = hit === "TP" ? Number(trade.tp) : Number(trade.sl);

      // slippage berekenen
      if (trade.desiredExitPrice > 0 && trade.entryPrice > 0) {
        const rawSlip =
          trade.mode === "bear"
            ? ((trade.desiredExitPrice - trade.exitPrice) / trade.entryPrice) * 100
            : ((trade.exitPrice - trade.desiredExitPrice) / trade.entryPrice) * 100;
        trade.slippagePct = Number(rawSlip.toFixed(4));
      } else {
        trade.slippagePct = null;
      }

      // fees en netPnl
      const feePctPerSide = Number(trade.feePctPerSide || 0.10);
      trade.feesPaidPct = Number((feePctPerSide * 2).toFixed(4));
      trade.netPnlPct = Number((trade.pnlPct - trade.feesPaidPct).toFixed(4));

      // holding time
      trade.holdingTimeSec = Math.floor((now - trade.openedAt) / 1000);
      trade.timeToExitSec = trade.holdingTimeSec;

      // opslaan gesloten trade (lange TTL)
      await kv.set(tradeKey, trade, { ex: 60 * 60 * 24 * 365 }); // 1 jaar

      // verwijder uit open set, voeg toe aan closed set
      await kv.srem(OPEN_SET, id);
      await kv.sadd(CLOSED_SET, id);

      // verwijder open index key (zodat scan nieuwe kan openen)
      await kv.del(openIndexKey({ funnel: trade.funnel, mode: trade.mode, symbol: trade.symbol }));

      // Discord notificatie
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
    json(res, 500, { ok: false, error: String(e) });
  } finally {
    try { await kv.del(LOCK_KEY); } catch {}
  }
}
