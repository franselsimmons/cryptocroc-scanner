// api/positions/manage.js

import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMainLatest,
  keyMainPortfolio,
  keyMainPositions,
  keyMainState,
  fetchBTCGateFromUniverse,
  calcPnlPct,
  hitStopOrTp,
} from "../../lib/_moon_core.js";

import { pushEvent } from "../../lib/_analytics.js";
import { sendSignal } from "../../lib/discordRouter.js";

import {
  n,
  up,
  enrichOpenPositionCoin,
  calculateThesisDamage,
  isThesisStillValid,
  makePortfolio,
  buildHoldCoins,
} from "../../lib/_position_manager.js";

export const config = RUNTIME_CONFIG;

// ======================================================
// Main constants
// ======================================================
const COOLDOWN_SL_SEC = 4 * 60 * 60;
const COOLDOWN_TP_SEC = 90 * 60;
const COOLDOWN_TIMEOUT_SEC = 2 * 60 * 60;
const COOLDOWN_EARLY_EXIT_SEC = 90 * 60;

const TIMEOUT_BARS = 12;
const TIMEOUT_MIN_PNL_PCT = 0.3;
const THESIS_BREAK_SCANS_FOR_EXIT = 3;
const MIN_HOLD_BARS_BEFORE_SOFT_EXIT = 3;
const BAR_MS = 30 * 60 * 1000;

// ======================================================
// Safe wrappers
// ======================================================
async function safePushEvent(name, payload) {
  try {
    await pushEvent(name, payload);
  } catch (e) {
    console.error(`pushEvent failed (${name}):`, e?.message || e);
  }
}

async function safeSendSignal(payload) {
  try {
    await sendSignal(payload);
  } catch (e) {
    console.error("sendSignal failed:", e?.message || e);
  }
}

// ======================================================
// BTC helper
// ======================================================
function isUsableBtc(btc) {
  if (!btc) return false;
  const price = n(btc.price, 0);
  const chg24 = n(btc.chg24, 0);
  const range24 = n(btc.range24, 0);
  const state = String(btc.state || "").toUpperCase();

  if (price > 0 && (Math.abs(chg24) > 0 || Math.abs(range24) > 0)) return true;
  if (price > 0 && (state === "BULL" || state === "BEAR")) return true;
  return false;
}

async function resolveBtcForMode(mode) {
  const fresh = await fetchBTCGateFromUniverse();
  if (isUsableBtc(fresh)) return fresh;

  try {
    const prevLatest = await kv.get(keyMainLatest(mode));
    if (isUsableBtc(prevLatest?.btc)) return prevLatest.btc;
  } catch {}

  return {
    price: n(fresh?.price, 0),
    chg24: n(fresh?.chg24, 0),
    chg1h: n(fresh?.chg1h, 0),
    range24: n(fresh?.range24, 0),
    state: String(fresh?.state || "NEUTRAL").toUpperCase(),
  };
}

// ======================================================
// Lock
// ======================================================
function lockKey(mode) {
  return `main:positions:lock:${String(mode || "bull").toLowerCase()}`;
}

async function acquireLock(mode) {
  const key = lockKey(mode);
  const now = Date.now();
  const ttlSec = 60 * 4;

  const ok = await kv.set(key, { ts: now, mode }, { nx: true, ex: ttlSec });
  if (ok) return true;

  const cur = await kv.get(key);
  const ts = n(cur?.ts, 0);
  if (ts > 0 && now - ts < ttlSec * 1000) return false;

  await kv.set(key, { ts: now, mode }, { ex: ttlSec });
  return true;
}

async function releaseLock(mode) {
  try {
    await kv.del(lockKey(mode));
  } catch {}
}

// ======================================================
// Cooldown key
// ======================================================
function cooldownKey(mode, symbol) {
  return `main:cooldown:${String(mode || "bull").toLowerCase()}:${up(symbol)}`;
}

// ======================================================
// Handler
// ======================================================
export default async function handler(req, res) {
  let mode = "bull";
  let acquired = false;

  try {
    if (!requireSecret(req, res)) return;
    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    acquired = await acquireLock(mode);
    if (!acquired) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: "position_manager_lock_active",
        mode,
      });
    }

    const now = Date.now();
    const btc = await resolveBtcForMode(mode);

    const prevPositions = (await kv.get(keyMainPositions(mode))) || { open: [], closed: [] };
    const positions = {
      open: Array.isArray(prevPositions?.open) ? [...prevPositions.open] : [],
      closed: Array.isArray(prevPositions?.closed) ? [...prevPositions.closed] : [],
    };

    const prevState = (await kv.get(keyMainState(mode))) || {};
    const nextState = { ...prevState };

    const latest = (await kv.get(keyMainLatest(mode))) || {};
    const scannerUniverse = [
      ...(latest?.candidates?.premium || []),
      ...(latest?.candidates?.tradeReady || []),
      ...(latest?.candidates?.watch || []),
      ...(latest?.candidates?.scannerOnly || []),
      ...(latest?.funnel?.elite_expansion || []),
      ...(latest?.funnel?.elite_ignition || []),
      ...(latest?.funnel?.almost || []),
      ...(latest?.funnel?.buildup || []),
      ...(latest?.funnel?.radar || []),
    ];

    const universeMap = new Map();
    for (const c of scannerUniverse) {
      if (c?.symbol) universeMap.set(up(c.symbol), c);
    }

    const updatedOpen = [];

    for (const pos of positions.open) {
      const sym = up(pos.symbol);

      const scannedCoin = universeMap.get(sym);
      const coin = await enrichOpenPositionCoin(
        scannedCoin,
        nextState[sym] || prevState?.[sym] || {},
        sym
      );

      const coinState = nextState[sym] || prevState?.[sym] || {};
      let thesisDamage = calculateThesisDamage(coin, coinState, mode);

      let thesisInvalidScans = n(coinState.thesisInvalidScans, 0);
      if (!isThesisStillValid(coin, coinState, mode)) {
        thesisInvalidScans++;
      } else {
        thesisInvalidScans = Math.max(0, thesisInvalidScans - 1);
      }

      const priceNow = n(coin?.price, 0) || n(pos.lastPrice, 0);
      const pnlPct = calcPnlPct({
        mode: pos.mode || mode,
        entryPrice: pos.entryPrice,
        priceNow,
      });
      const barsHeld = Math.floor((now - n(pos.entryAt, now)) / BAR_MS);

      const hit = hitStopOrTp({
        mode: pos.mode || mode,
        priceNow,
        sl: pos.sl,
        tp3: pos.tp,
      });

      let exitReason = null;
      if (hit.hit && hit.kind === "SL") exitReason = "stop_loss";
      else if (hit.hit && hit.kind === "TP") exitReason = "take_profit";

      if (
        !exitReason &&
        barsHeld >= TIMEOUT_BARS &&
        pnlPct < TIMEOUT_MIN_PNL_PCT &&
        thesisDamage.damage >= 2 &&
        thesisInvalidScans >= 1 &&
        coin?.breakout?.ready === false
      ) {
        exitReason = "timeout";
      }

      if (
        !exitReason &&
        thesisInvalidScans >= THESIS_BREAK_SCANS_FOR_EXIT &&
        barsHeld >= MIN_HOLD_BARS_BEFORE_SOFT_EXIT
      ) {
        exitReason = "thesis_break";
      }

      if (exitReason) {
        const pnlUsd = (n(pos.sizeUsd, 0) * pnlPct) / 100;
        const closedPos = {
          ...pos,
          exitPrice: priceNow,
          exitAt: now,
          pnlUsd,
          pnlPct,
          exitReason,
        };

        positions.closed.push(closedPos);

        const cdKey = cooldownKey(mode, sym);
        let cdSec = COOLDOWN_SL_SEC;
        if (exitReason === "take_profit") cdSec = COOLDOWN_TP_SEC;
        else if (exitReason === "timeout") cdSec = COOLDOWN_TIMEOUT_SEC;
        else if (exitReason === "thesis_break") cdSec = COOLDOWN_EARLY_EXIT_SEC;

        await kv.set(cdKey, now + cdSec * 1000, { ex: cdSec * 2 });

        nextState[sym] = {
          ...coinState,
          price: priceNow,
          lastPrice: priceNow,
          ob: coin?.ob || coinState.ob,
          breakout: coin?.breakout || coinState.breakout,
          compression: coin?.compression || coinState.compression,
          volAcc: coin?.volAcc || coinState.volAcc,
          thresholds: coin?.thresholds || coinState.thresholds,
          tradePlan: coin?.tradePlan || coinState.tradePlan,
          stage: coin?.stage || coinState.stage,
          stageWhy: coin?.stageWhy || coinState.stageWhy,
          entryActive: false,
          entryLocked: true,
          candidateSince: null,
          eliteScans: 0,
          strongScans: 0,
          weakScans: 0,
          thesisInvalidScans: 0,
          entryReady: false,
          lastExit: now,
          lastExitReason: exitReason,
          thesisDamage: thesisDamage.damage,
          thesisReasons: thesisDamage.reasons,
          pnlPct,
          pnlUsd,
        };

        await safePushEvent("trade_closed", {
          id: pos.id,
          mode,
          symbol: sym,
          entry: pos.entryPrice,
          exit: closedPos.exitPrice,
          pnlPct: closedPos.pnlPct,
          pnlUsd: closedPos.pnlUsd,
          reason: exitReason,
          holdBars: barsHeld,
          source: "position_manager_main",
        });

        await safeSendSignal({
          source: "main",
          stage: coin?.stage || coinState.stage || "HOLD",
          mode,
          coin: coin,
          btcState: btc?.state || "NEUTRAL",
          kind: "trade_closed",
          pnl: closedPos.pnlPct,
          reason: exitReason,
        });

        continue;
      }

      const pnlUsd = (n(pos.sizeUsd, 0) * pnlPct) / 100;
      const updatedPos = {
        ...pos,
        lastPrice: priceNow,
        lastUpdate: now,
        pnlPct,
        pnlUsd,
      };
      updatedOpen.push(updatedPos);

      const prevPnl = n(coinState.pnlPct, 0);
      const stageNow = coin?.stage || coinState.stage || "";

      nextState[sym] = {
        ...coinState,
        name: coin?.name || coinState.name || sym,
        image: coin?.image || coinState.image || "",
        price: priceNow,
        lastPrice: priceNow,
        marketCap: n(coin?.marketCap, coinState.marketCap),
        volume: n(coin?.volume, coinState.volume),
        change24: n(coin?.change24, coinState.change24),
        change1h: n(coin?.change1h, coinState.change1h),
        vm: n(coin?.vm, coinState.vm),
        ob: coin?.ob || coinState.ob,
        breakout: coin?.breakout || coinState.breakout,
        compression: coin?.compression || coinState.compression,
        volAcc: coin?.volAcc || coinState.volAcc,
        thresholds: coin?.thresholds || coinState.thresholds,
        tradePlan: coin?.tradePlan || coinState.tradePlan,
        stage: stageNow,
        stageWhy: coin?.stageWhy || coinState.stageWhy,
        entryQuality: n(coin?.entryQuality, coinState.entryQuality),
        persistenceScore: n(coin?.persistenceScore, coinState.persistenceScore),
        moveScore: n(coin?.moveScore, coinState.moveScore),
        velocity: n(coin?.velocity, coinState.velocity),
        thesisInvalidScans,
        thesisDamage: thesisDamage.damage,
        thesisReasons: thesisDamage.reasons,
        entryLocked: true,
        entryActive: true,
        entryReady: false,
        pnlPct,
        pnlUsd,
      };

      if (
        Math.abs(pnlPct - prevPnl) >= 2.0 ||
        thesisDamage.damage !== n(coinState.thesisDamage, 0) ||
        stageNow !== coinState.stage
      ) {
        await safePushEvent("scan_hold", {
          mode,
          symbol: sym,
          stage: stageNow,
          pnlPct,
          thesisDamage: thesisDamage.damage,
          reasons: thesisDamage.reasons,
          source: "position_manager_main",
        });

        await safeSendSignal({
          source: "main",
          stage: stageNow || "HOLD",
          mode,
          coin,
          btcState: btc?.state || "NEUTRAL",
          kind: "position_update",
          pnl: pnlPct,
          reason:
            thesisDamage.damage > 0
              ? `Thesis damage ${thesisDamage.damage}`
              : `Position update ${pnlPct.toFixed(2)}%`,
        });
      }
    }

    positions.open = updatedOpen;
    positions.closed = positions.closed.slice(-1000);

    const portfolio = makePortfolio(mode, positions);

    await kv.set(keyMainState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(keyMainPositions(mode), positions, { ex: 60 * 60 * 24 * 7 });
    await kv.set(keyMainPortfolio(mode), portfolio, { ex: 60 * 60 * 24 * 7 });

    const hold = buildHoldCoins({
      positions,
      universeMap,
      stateMap: nextState,
      now,
    }).slice(0, 20);

    const latestNext = {
      ...latest,
      portfolio,
      positions: {
        open: positions.open.length,
        closed: positions.closed.length,
      },
      funnel: {
        ...(latest?.funnel || {}),
        hold,
      },
      counts: {
        ...(latest?.counts || {}),
        hold: hold.length,
      },
      ts: now,
      managedAt: now,
    };

    await kv.set(keyMainLatest(mode), latestNext, { ex: 60 * 60 });

    return res.status(200).json({
      ok: true,
      mode,
      managed: positions.open.length,
      closedTotal: positions.closed.length,
      portfolio,
      ts: now,
    });
  } catch (err) {
    console.error("Main position manager error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (acquired) await releaseLock(mode);
  }
}