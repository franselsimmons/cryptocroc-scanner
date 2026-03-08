import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  MOON,
  keyMoonLatest,
  keyMoonState,
  keyMoonReset,
  keyMoonObResult,
  keyMoonPositions,
  keyMoonPortfolio,
  fetchBTCGateCached,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
  passRadarMoon,
  passBuildupMoon,
  passAlmostMoon,
  passEliteMoon,
  updatePriceHist,
  updateVolHist,
  volAccFromHist,
  priceFlatPct,
  computeConfidence,
  depthFloorUsd,
  computeMoonRisk,
  getTierForMcap,
  isModeAllowedByBtc,
  calcPnlPct,
  hitStopOrTp,
  saveMoonDiag,
  sendDiscord,
  webhookForMoonStage,
  webhookMoonPortfolio,
  fmtMoonLine,
  fmtTs,
  durMinutes,
  fmtModeLabel,
  tryAcquireMoonScanLock,
  setMoonCooldown,
  hasMoonCooldown,
} from "../../lib/_moon_core.js";

import {
  uid,
  pushEvent,
  readTrades,
  writeTrades,
  addPostWatch,
  pnlPctFromPrices,
} from "../../lib/_analytics.js";

import {
  logMoonSignal,
  computeInstability
} from "../../lib/_moon_logger.js";

export const config = RUNTIME_CONFIG;

const MAX_SNAPSHOTS = 3;
const POST_WATCH_HOURS = 24;

function inc(map, k) {
  const key = String(k || "unknown");
  map[key] = (map[key] || 0) + 1;
}

function updateSnapshots(prevSnapshots, snapshot) {
  const arr = Array.isArray(prevSnapshots) ? [...prevSnapshots] : [];
  arr.push(snapshot);
  while (arr.length > MAX_SNAPSHOTS) arr.shift();
  return arr;
}

function computeRollingMetrics(snaps) {
  if (!snaps || snaps.length < 3) {
    return {
      deltaPrice15m: 0,
      deltaVol15m: 0,
      compression: false,
      obSlope: 0,
      obStability: 0,
      atrEst: 0,
    };
  }

  const [s1, s2, s3] = snaps;

  const deltaPrice15m = s1.price > 0 ? ((s3.price - s1.price) / s1.price) * 100 : 0;
  const deltaVol15m = Number(s3.volAcc || 0) - Number(s1.volAcc || 0);

  const compression =
    Number(s3.range24 || 0) < Number(s2.range24 || 0) &&
    Number(s2.range24 || 0) < Number(s1.range24 || 0);

  const slope1 = Number(s2.obScore || 0) - Number(s1.obScore || 0);
  const slope2 = Number(s3.obScore || 0) - Number(s2.obScore || 0);
  const obSlope = (slope1 + slope2) / 2;

  const scores = snaps.map((s) => Number(s.obScore || 0));
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / scores.length;
  const obStability = Math.sqrt(variance);

  const move1 = s1.price > 0 ? Math.abs((s2.price - s1.price) / s1.price) : 0;
  const move2 = s2.price > 0 ? Math.abs((s3.price - s2.price) / s2.price) : 0;
  const atrEst = (move1 + move2) / 2;

  return { deltaPrice15m, deltaVol15m, compression, obSlope, obStability, atrEst };
}

function normalizePositionsStore(prev) {
  const base = prev && typeof prev === "object" ? prev : {};
  const open = Array.isArray(base.open) ? base.open : [];
  const closed = Array.isArray(base.closed) ? base.closed : [];
  return { open, closed };
}

function calcPortfolioFromPositions(mode, store) {
  const posUsd = MOON.portfolio.posUsd;

  let openCount = 0;
  let closedCount = 0;

  let realizedUsd = 0;
  let realizedPctSum = 0;

  for (const t of store.closed) {
    closedCount++;
    realizedUsd += Number(t.pnlUsd || 0);
    realizedPctSum += Number(t.pnlPct || 0);
  }

  for (const t of store.open) {
    if (t?.status === "HOLD" || t?.status === "ENTRY") openCount++;
  }

  const avgRealizedPct = closedCount ? realizedPctSum / closedCount : 0;

  return {
    mode,
    posUsd,
    openCount,
    closedCount,
    realizedUsd: +realizedUsd.toFixed(2),
    avgRealizedPct: +avgRealizedPct.toFixed(2),
    updatedAt: Date.now(),
  };
}

function buildSymbolPriceMap(cgList) {
  const map = new Map();
  for (const c of cgList || []) {
    const sym = String(c?.symbol || "").toUpperCase();
    if (!sym) continue;
    map.set(sym, Number(c?.price || 0));
  }
  return map;
}

// ===== Mirror trades store (analytics) =====
async function openMoonTradeMirror({ mode, c, risk, confidence, obView, depthUsd }) {
  const trades = await readTrades("moon");

  const exists = trades.find(
    (t) => String(t.status) === "OPEN" && String(t.symbol) === String(c.symbol) && String(t.mode) === String(mode)
  );
  if (exists) return;

  const t = {
    id: uid("moon"),
    funnel: "moon",
    status: "OPEN",
    mode,
    symbol: c.symbol,
    cgId: c.id,

    entryAt: Date.now(),
    entryPrice: Number(c.price),

    sl: Number(risk?.sl || 0),
    tp: Number(risk?.tp3 || 0),

    lastPrice: Number(c.price),
    pnlPct: 0,

    snap: {
      vm: Number(c.vm || 0),
      confidence: Number(confidence || 0),
      spreadPct: Number(obView?.spreadPct ?? 0),
      depthUsd: Number(depthUsd || 0),
    },

    mfePct: 0,
    maePct: 0,

    postBestPct: null,
    postWorstPct: null,
  };

  trades.push(t);
  await writeTrades("moon", trades);

  await pushEvent("moon", {
    ts: Date.now(),
    funnel: "moon",
    mode,
    symbol: c.symbol,
    type: "TRADE_OPEN",
    entryPrice: c.price,
    sl: t.sl,
    tp: t.tp,
    confidence,
    vm: c.vm,
  });
}

async function closeMoonTradeMirror({ mode, symbol, priceNow, reason }) {
  const trades = await readTrades("moon");
  const now = Date.now();

  const idx = trades.findIndex(
    (t) => String(t.status) === "OPEN" && String(t.mode) === String(mode) && String(t.symbol) === String(symbol)
  );
  if (idx < 0) return;

  const t = trades[idx];

  t.status = "CLOSED";
  t.exitAt = now;
  t.exitPrice = Number(priceNow || t.entryPrice);
  t.exitReason = String(reason || "SELL");

  const pnl = pnlPctFromPrices({ mode: t.mode, entryPrice: t.entryPrice, priceNow: t.exitPrice });
  t.pnlPct = +Number(pnl || 0).toFixed(2);

  const until = now + POST_WATCH_HOURS * 60 * 60 * 1000;
  await addPostWatch("moon", t.id, until);

  trades[idx] = t;
  await writeTrades("moon", trades);

  await pushEvent("moon", {
    ts: now,
    funnel: "moon",
    mode,
    symbol,
    type: "TRADE_CLOSE",
    reason: t.exitReason,
    pnlPct: t.pnlPct,
  });
}

async function updateMoonTradeMfeMae({ mode, symbol, priceNow }) {
  const trades = await readTrades("moon");
  const idx = trades.findIndex(
    (t) => String(t.status) === "OPEN" && String(t.mode) === String(mode) && String(t.symbol) === String(symbol)
  );
  if (idx < 0) return;

  const t = trades[idx];
  t.lastPrice = Number(priceNow || t.lastPrice || 0);

  const pnl = pnlPctFromPrices({ mode: t.mode, entryPrice: t.entryPrice, priceNow: t.lastPrice });
  const pnlPct = +Number(pnl || 0).toFixed(2);
  t.pnlPct = pnlPct;

  t.mfePct = t.mfePct == null ? pnlPct : Math.max(Number(t.mfePct || 0), pnlPct);
  t.maePct = t.maePct == null ? pnlPct : Math.min(Number(t.maePct || 0), pnlPct);

  trades[idx] = t;
  await writeTrades("moon", trades);
}

// 🔧 Helper: sluit mirror trades waarvan het symbool niet meer in live universe zit
async function pruneMoonTradeMirrorToLiveUniverse(mode, liveSyms) {
  const trades = await readTrades("moon");
  let changed = false;

  for (const t of trades) {
    if (
      String(t?.status) === "OPEN" &&
      String(t?.mode) === String(mode) &&
      !liveSyms.has(String(t?.symbol || "").toUpperCase())
    ) {
      t.status = "CLOSED";
      t.exitAt = Date.now();
      t.exitPrice = Number(t.lastPrice || t.entryPrice || 0);
      t.exitReason = "UNIVERSE_DROP";
      t.pnlPct = +Number(
        pnlPctFromPrices({
          mode: t.mode,
          entryPrice: t.entryPrice,
          priceNow: t.exitPrice,
        }) || 0
      ).toFixed(2);
      changed = true;
    }
  }

  if (changed) {
    await writeTrades("moon", trades);
  }
}

function computeRegime(btcRange24) {
  if (btcRange24 < 3) return "low";
  if (btcRange24 < 6) return "mid";
  return "high";
}

// ===== Verbeterde consistency (gebruikt snapshots voor volAcc) =====
function computeMoonConsistency(mode, snapshots, priceHist) {
  const arr = Array.isArray(snapshots) ? snapshots.slice(-3) : [];
  if (arr.length < 2) {
    return {
      ok: false,
      ratio: 0,
      total: 0,
      same: 0,
      details: { obRatio: 0, volTrendOk: false, priceTrendOk: false }
    };
  }

  let obSame = 0;
  for (const s of arr) {
    const score = Number(s?.obScore || 0);
    const aligned = mode === "bull" ? score > 0 : score < 0;
    if (aligned) obSame++;
  }
  const obRatio = obSame / arr.length;

  let volTrendOk = false;
  if (arr.length >= 2) {
    const lastVolAcc = Number(arr[arr.length - 1]?.volAcc || 0);
    const prevVolAcc = Number(arr[arr.length - 2]?.volAcc || 0);
    volTrendOk = lastVolAcc > prevVolAcc;
  }

  let priceTrendOk = false;
  if (Array.isArray(priceHist) && priceHist.length >= 2) {
    const lastPrice = Number(priceHist[priceHist.length - 1] || 0);
    const prevPrice = Number(priceHist[priceHist.length - 2] || 0);
    if (mode === "bull") priceTrendOk = lastPrice > prevPrice;
    else priceTrendOk = lastPrice < prevPrice;
  }

  const ok = obRatio >= 0.66 && (volTrendOk || priceTrendOk);

  return {
    ok,
    ratio: +obRatio.toFixed(3),
    total: arr.length,
    same: obSame,
    details: { obRatio: +obRatio.toFixed(3), volTrendOk, priceTrendOk }
  };
}

export default async function handler(req, res) {
  // 🔧 Lock variabele buiten try voor finally
  let lock = null;

  try {
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";
    const now = Date.now();

    // 🔧 Scan lock – voorkom dubbele runs
    lock = await tryAcquireMoonScanLock(mode, 90);
    if (!lock.ok) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: true,
        skipped: true,
        mode,
        reason: "Moon scan already running",
      }));
    }

    const diag = {
      ts: now,
      mode,
      btc: null,
      allowed: null,
      universe: { cgTotal: 0, afterBitget: 0, afterRadar: 0 },
      counts: { radar: 0, buildup: 0, almost: 0, elite: 0 },
      reasons: {
        radarOut: {},
        buildupWhy: {},
        almostWhy: {},
        eliteWhy: {},
        eliteExtraFail: {},
        obReason: {},
      },
      samples: {
        radarOut: [],
        eliteBlocked: [],
      },
      settings: {
        radar: MOON.radar,
        buildup: MOON.buildup,
        almost: MOON.almost,
        elite: MOON.elite,
        tiers: MOON.tiers,
      },
    };

    const btc = await fetchBTCGateCached();
    const allowed = isModeAllowedByBtc(mode, btc.state);
    diag.btc = btc;
    diag.allowed = allowed;

    const resetAt = (await kv.get(keyMoonReset(mode))) || 0;
    const state = (await kv.get(keyMoonState(mode))) || {};

    const positionsPrev = await kv.get(keyMoonPositions(mode));
    const positions = normalizePositionsStore(positionsPrev);

    if (!allowed && MOON.portfolio.closeOnBtcFlip && positions.open.length) {
      const cgNow = await fetchCoinGeckoTopCached();
      const priceMap = buildSymbolPriceMap(cgNow);

      const toReview = [...positions.open];
      positions.open = [];

      for (const t of toReview) {
        const px = priceMap.get(t.symbol) || Number(t.lastPrice || t.entryPrice || 0) || Number(t.entryPrice || 0);
        const pnlPct = calcPnlPct({ mode: t.mode, entryPrice: t.entryPrice, priceNow: px });
        const pnlUsd = (Number(t.posUsd || MOON.portfolio.posUsd) * pnlPct) / 100;
        const ageMin = Math.round((now - Number(t.entryAt || now)) / 60000);

        const shouldForceClose =
          Number(px || 0) === 0 ||
          Math.abs(Number(pnlPct || 0)) < 1.5 ||
          ageMin >= 180;

        if (shouldForceClose) {
          const closedTrade = {
            ...t,
            status: "SELL",
            exitReason: "BTC_GATE_FLIP",
            exitAt: now,
            exitPrice: +Number(px || t.entryPrice).toFixed(8),
            pnlPct: +pnlPct.toFixed(2),
            pnlUsd: +pnlUsd.toFixed(2),
          };

          positions.closed.push(closedTrade);

          await closeMoonTradeMirror({
            mode: t.mode,
            symbol: t.symbol,
            priceNow: px,
            reason: "BTC_GATE_FLIP",
          });

          // 🔧 Cooldown na forced close
          await setMoonCooldown(t.mode, t.symbol, 120);

          const hook = webhookMoonPortfolio() || webhookForMoonStage("ELITE");
          if (hook) {
            const mins = durMinutes(closedTrade.entryAt, closedTrade.exitAt);

            const msg =
              `**${closedTrade.symbol}** → **SELL** (MOON ${fmtModeLabel(closedTrade.mode)})\n` +
              `Opened: ${fmtTs(closedTrade.entryAt)}\n` +
              `Closed: ${fmtTs(closedTrade.exitAt)}\n` +
              `Duration: ${mins} min\n` +
              `Reason: BTC_GATE_FLIP\n` +
              `Exit: $${Number(closedTrade.exitPrice).toFixed(8)} | PnL: ${closedTrade.pnlPct >= 0 ? "+" : ""}${closedTrade.pnlPct}% ($${closedTrade.pnlUsd})`;
            await sendDiscord(hook, msg);
          }
        } else {
          positions.open.push({
            ...t,
            status: "HOLD",
            lastPrice: +Number(px || t.lastPrice || t.entryPrice).toFixed(8),
            note: "BTC flip soft-hold",
          });
        }
      }
    }

    if (!allowed) {
      const portfolio = calcPortfolioFromPositions(mode, positions);

      await kv.set(keyMoonPortfolio(mode), portfolio, { ex: 60 * 60 * 24 * 30 });
      await kv.set(keyMoonPositions(mode), positions, { ex: 60 * 60 * 24 * 30 });

      const result = {
        ok: true,
        ts: now,
        mode,
        btc,
        counts: { radar: 0, buildup: 0, almost: 0, elite: 0 },
        funnel: { elite: [], almost: [], buildup: [], radar: [] },
        portfolio,
        note: "Blocked: BTC is opposite side for this mode.",
      };

      await kv.set(keyMoonLatest(mode), result, { ex: 60 * 60 * 2 });

      diag.counts = result.counts;
      await saveMoonDiag(mode, diag);

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(result));
    }

    const bitgetSet = await getBitgetSpotUsdtSymbols();
    const cg = await fetchCoinGeckoTopCached();

    diag.universe.cgTotal = cg.length;

    const radarRaw = cg.filter((c) => bitgetSet.has(String(c.symbol || "").toUpperCase()));
    diag.universe.afterBitget = radarRaw.length;

    const radarFiltered = radarRaw
      .filter((c) => passRadarMoon(c, mode))
      .sort((a, b) => {
        if (b.vm !== a.vm) return b.vm - a.vm;
        if (b.volume !== a.volume) return b.volume - a.volume;
        return a.marketCap - b.marketCap;
      })
      .slice(0, MOON.RADAR_LIMIT);

    diag.universe.afterRadar = radarFiltered.length;

    const liveSyms = new Set(radarFiltered.map((c) => c.symbol));

    // 🔧 Verwijder niet-live symbols uit state
    for (const sym of Object.keys(state)) {
      if (!liveSyms.has(sym)) delete state[sym];
    }

    // 🔧 Filter open positions op live universe
    positions.open = positions.open.filter((t) => liveSyms.has(String(t.symbol || "").toUpperCase()));

    // 🔧 Sync mirror trades met live universe
    await pruneMoonTradeMirrorToLiveUniverse(mode, liveSyms);

    const radar = [];
    const buildup = [];
    const almost = [];
    const elite = [];

    const findOpen = (sym) => positions.open.find((t) => t.symbol === sym);
    const canOpenNew = () => positions.open.length < MOON.portfolio.maxOpen;

    for (const c of radarFiltered) {
      const sym = c.symbol;

      // 🔧 Cooldown check
      const inCooldown = await hasMoonCooldown(mode, sym);
      if (inCooldown) inc(diag.reasons.eliteExtraFail, "Cooldown active");

      const tier = getTierForMcap(c.marketCap);

      const prev = state[sym] || {
        enteredAt: now,
        stageAt: now,
        lastSeenAt: 0,
        priceHist: [],
        volHist: [],
        snapshots: [],
        stage: "RADAR",
      };

      if (Number(prev.enteredAt || 0) < resetAt) {
        prev.enteredAt = now;
        prev.stageAt = now;
        prev.priceHist = [];
        prev.volHist = [];
        prev.snapshots = [];
        prev.stage = "RADAR";
      }

      const priceHist = updatePriceHist(prev.priceHist, c.price);
      const volHist = updateVolHist(prev.volHist, c.volume);
      const volAcc = volAccFromHist(volHist);
      const flat60 = priceFlatPct(priceHist, 60);

      const obRaw = await kv.get(keyMoonObResult(mode, sym));
      const obScore = Number(obRaw?.ob?.score ?? obRaw?.score ?? 0);

      const snapshot = { ts: now, price: c.price, volAcc, range24: c.range24, obScore };
      const snapshots = updateSnapshots(prev.snapshots, snapshot);
      const rolling = computeRollingMetrics(snapshots);

      const obTs = Number(obRaw?.sampledAt ?? obRaw?.ob?.ts ?? 0);
      const obIsStale = !(obTs > 0) || (now - obTs > 25 * 60 * 1000);

      const obView = obRaw
        ? {
            valid: !!obRaw.valid && !obIsStale,
            stale: !!obRaw.stale || obIsStale,
            score: obScore,
            spreadPct: Number(obRaw?.ob?.spreadPct ?? 999),
            lor: Number(obRaw?.ob?.lor ?? 1),
            agree: Number(obRaw?.agree ?? 0),
            bidUsd: Number(obRaw?.ob?.bidUsd ?? 0),
            askUsd: Number(obRaw?.ob?.askUsd ?? 0),
            reason: obIsStale ? "OB stale" : String(obRaw?.reason || ""),
            ts: obTs || null,
          }
        : null;

      if (obView?.reason) inc(diag.reasons.obReason, obView.reason);

      const depthUsd = obView ? Math.min(obView.bidUsd, obView.askUsd) : 0;
      const floorUsd = depthFloorUsd(c.marketCap, tier);
      const depthOk = depthUsd >= floorUsd;

      const confidence = computeConfidence({
        obScore,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc,
      });

      const consistency = computeMoonConsistency(mode, snapshots, priceHist);
      const consistencyRatio = consistency.ratio;

      const buildupGate = passBuildupMoon({ c, volAcc });
      inc(diag.reasons.buildupWhy, buildupGate.why);

      const almostGate = passAlmostMoon({ priceHist, volAcc, confidence, consistencyRatio, tier });
      inc(diag.reasons.almostWhy, almostGate.why);

      const eliteGate = passEliteMoon({
        mode,
        obView,
        confidence,
        consistencyRatio,
        depthUsd,
        floorUsd,
        range24: c.range24,
        tier,
      });
      inc(diag.reasons.eliteWhy, eliteGate.why);

      const rollCfg = MOON.elite.roll;
      const needCompression = tier?.needCompression ?? rollCfg.needCompression;
      const maxObStability = tier?.maxObStability ?? rollCfg.maxObStability;

      const priceOk = rolling.deltaPrice15m <= rollCfg.maxDeltaPrice15mPct;
      const volOk = rolling.deltaVol15m >= rollCfg.minDeltaVol15m;
      const slopeOk = rolling.obSlope >= rollCfg.minObSlope;
      const compressionOk = !needCompression || rolling.compression;
      const stabilityOk = rolling.obStability <= maxObStability;

      const eliteExtra = priceOk && volOk && slopeOk && compressionOk && stabilityOk;

      if (!eliteExtra) {
        if (!priceOk) inc(diag.reasons.eliteExtraFail, "ΔP15m too high");
        else if (!volOk) inc(diag.reasons.eliteExtraFail, "ΔV15m too low");
        else if (!slopeOk) inc(diag.reasons.eliteExtraFail, "OB slope too low");
        else if (!compressionOk) inc(diag.reasons.eliteExtraFail, "No compression");
        else if (!stabilityOk) inc(diag.reasons.eliteExtraFail, "OB too spiky");
        else inc(diag.reasons.eliteExtraFail, "Unknown");
      }

      let stage = "RADAR";
      if (eliteGate.ok && eliteExtra) stage = "ELITE";
      else if (almostGate.ok) stage = "ALMOST";
      else if (buildupGate.ok) stage = "BUILDUP";

      const prevStage = String(prev.stage || "RADAR");

      const risk = computeMoonRisk({
        mode,
        price: c.price,
        range24: c.range24,
        confidence,
        depthOk,
        tier,
      });

      let trade = findOpen(sym) || null;

      let openedNow = false;
      // 🔧 Alleen openen als niet in cooldown
      if (!trade && !inCooldown && stage === "ELITE" && canOpenNew() && risk?.sl && risk?.tp3) {
        const posUsd = MOON.portfolio.posUsd;
        const qty = posUsd / Number(c.price || 1);

        trade = {
          symbol: sym,
          mode,
          status: "ENTRY",
          entryAt: now,
          entryPrice: Number(c.price),
          qty: +qty.toFixed(8),
          sl: Number(risk.sl),
          tp3: Number(risk.tp3),
          posUsd,
          lastPrice: Number(c.price),
          note: "Opened on ELITE",
        };
        positions.open.push(trade);
        openedNow = true;

        await openMoonTradeMirror({ mode, c, risk, confidence, obView, depthUsd });
      }

      let closedNow = null;
      if (trade) {
        if (trade.status === "ENTRY") trade.status = "HOLD";

        trade.lastPrice = Number(c.price);

        await updateMoonTradeMfeMae({ mode, symbol: sym, priceNow: c.price });

        const pnlPct = calcPnlPct({ mode, entryPrice: trade.entryPrice, priceNow: c.price });
        const pnlUsd = (trade.posUsd * pnlPct) / 100;

        const hit = hitStopOrTp({ mode, priceNow: c.price, sl: trade.sl, tp3: trade.tp3 });

        if (hit.hit) {
          trade.status = "SELL";
          trade.exitAt = now;
          trade.exitPrice = Number(c.price);
          trade.exitReason = hit.kind;
          trade.pnlPct = +pnlPct.toFixed(2);
          trade.pnlUsd = +pnlUsd.toFixed(2);

          positions.open = positions.open.filter((t) => t.symbol !== sym);
          positions.closed.push(trade);

          closedNow = { ...trade };

          await closeMoonTradeMirror({ mode, symbol: sym, priceNow: c.price, reason: hit.kind });

          // 🔧 Cooldown na TP/SL
          await setMoonCooldown(mode, sym, 90);

          // 🔧 Na sluiting niet meer in elite/almost plaatsen
          trade = null;
          stage = "RADAR";
        } else {
          trade.pnlPct = +pnlPct.toFixed(2);
          trade.pnlUsd = +pnlUsd.toFixed(2);
        }
      }

      // 🔧 Stage change detection na trade-close logica
      const stageChanged = prevStage !== stage;

      if (stageChanged) {
        await pushEvent("moon", {
          ts: now,
          funnel: "moon",
          mode,
          symbol: sym,
          type: "STAGE",
          from: prevStage,
          to: stage,
          metrics: {
            vm: c.vm,
            volAcc,
            confidence,
            spreadPct: obView?.spreadPct ?? null,
            depthUsd,
            depthFloorUsd: floorUsd,
            rolling,
            tier: tier.name,
            consistency,
          },
        });
      }

      const item = {
        id: c.id,
        symbol: sym,
        name: c.name,
        price: c.price,
        change24: c.change24,
        range24: c.range24,
        volume: c.volume,
        marketCap: c.marketCap,
        vm: c.vm,

        stage,

        volAcc: +Number(volAcc || 1).toFixed(3),
        priceFlat60: +Number(flat60 || 0).toFixed(2),

        confidence,
        consistency,

        rolling,

        ob: obView || { status: "none" },

        depthUsd,
        floorUsd,
        depthOk,

        risk,
        trade: trade
          ? {
              status: trade.status,
              entryPrice: trade.entryPrice,
              sl: trade.sl,
              tp3: trade.tp3,
              pnlPct: trade.pnlPct ?? 0,
              pnlUsd: trade.pnlUsd ?? 0,
              exitReason: trade.exitReason ?? null,
            }
          : null,

        why: {
          buildup: buildupGate.why,
          almost: almostGate.why,
          elite: eliteGate.why,
          eliteExtra: eliteExtra ? "ROLLING ok" : "ROLLING fail",
          cooldown: inCooldown ? "Cooldown active" : "No cooldown",
        },
        tier: tier.name,
      };

      if (stageChanged) {
        const hook = webhookForMoonStage(stage);
        if (hook) {
          const extra =
            `tier: ${tier.name} | why: ${item.why.eliteExtra} | depth: $${Math.round(depthUsd)} (floor $${Math.round(floorUsd)})\n` +
            `rolling: ΔP15m ${Number(rolling.deltaPrice15m || 0).toFixed(2)}% | ΔV15m ${Number(rolling.deltaVol15m || 0).toFixed(2)} | slope ${Number(rolling.obSlope || 0).toFixed(4)} | stab ${Number(rolling.obStability || 0).toFixed(4)}`;
          await sendDiscord(hook, fmtMoonLine(item, mode, extra, now));
        }
      }

      if (openedNow) {
        const hook = webhookMoonPortfolio() || webhookForMoonStage("ELITE");
        if (hook) {
          const msg =
            `**${sym}** → **OPEN** (MOON ${fmtModeLabel(mode)})\n` +
            `tier: ${tier.name}\n` +
            `Opened: ${fmtTs(trade.entryAt)}\n` +
            `Entry: $${Number(item.price).toFixed(8)} | SL: $${Number(item.risk?.sl || 0).toFixed(8)} | TP3: $${Number(item.risk?.tp3 || 0).toFixed(8)}\n` +
            `confidence: ${item.confidence}/100 | depthOk: ${item.depthOk ? "yes" : "no"}`;
          await sendDiscord(hook, msg);
        }
      }

      if (closedNow) {
        const hook = webhookMoonPortfolio() || webhookForMoonStage("ELITE");
        if (hook) {
          const mins = durMinutes(closedNow.entryAt, closedNow.exitAt);

          const msg =
            `**${closedNow.symbol}** → **SELL** (MOON ${fmtModeLabel(closedNow.mode)})\n` +
            `Opened: ${fmtTs(closedNow.entryAt)}\n` +
            `Closed: ${fmtTs(closedNow.exitAt)}\n` +
            `Duration: ${mins} min\n` +
            `Reason: ${closedNow.exitReason}\n` +
            `Exit: $${Number(closedNow.exitPrice).toFixed(8)} | PnL: ${closedNow.pnlPct >= 0 ? "+" : ""}${closedNow.pnlPct}% ($${closedNow.pnlUsd})`;
          await sendDiscord(hook, msg);
        }
      }

      state[sym] = {
        enteredAt: prev.enteredAt || now,
        stageAt: stageChanged ? now : (prev.stageAt || now),
        lastSeenAt: now,
        priceHist,
        volHist,
        snapshots,
        stage,
      };

      if (stage === "ELITE") {
        elite.push(item);

        const regime = computeRegime(btc.range24);

        const instability = computeInstability({
          direction: mode,
          volumeRoc5m: rolling.deltaVol15m,
          obSlope: rolling.obSlope,
          obStability: rolling.obStability,
          depthBidUsd: obView?.bidUsd || 0,
          depthAskUsd: obView?.askUsd || 0,
        });

        await logMoonSignal({
          symbol: sym,
          direction: mode,
          price: c.price,

          btc_state: btc.state,
          btc_atr_pct: btc.range24,
          market_regime: regime,

          market_cap: c.marketCap,
          range_24h_pct: c.range24,

          volume_roc_5m: rolling.deltaVol15m,
          ob_score: obScore,
          ob_slope: rolling.obSlope,
          ob_stability: rolling.obStability,

          depth_bid_usd: obView?.bidUsd || 0,
          depth_ask_usd: obView?.askUsd || 0,

          instability_score_raw: instability,
          confidence,
        });
      }
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    const sortKey = (a, b) =>
      (b.confidence - a.confidence) ||
      ((b.rolling?.deltaVol15m || 0) - (a.rolling?.deltaVol15m || 0)) ||
      (b.volAcc - a.volAcc) ||
      (b.vm - a.vm);

    elite.sort(sortKey);
    almost.sort(sortKey);
    buildup.sort(sortKey);
    radar.sort((a, b) => (b.volAcc - a.volAcc) || (b.vm - a.vm));

    const portfolio = calcPortfolioFromPositions(mode, positions);

    diag.counts = { radar: radar.length, buildup: buildup.length, almost: almost.length, elite: elite.length };

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      counts: diag.counts,
      funnel: { elite, almost, buildup, radar },
      portfolio,
      note: btc.state === "NEUTRAL" ? "BTC gate SOFT-OPEN: NEUTRAL allowed." : undefined,
    };

    // 🔧 TTL's toegevoegd
    await kv.set(keyMoonLatest(mode), result, { ex: 60 * 60 * 2 });
    await kv.set(keyMoonState(mode), state, { ex: 60 * 60 * 24 * 7 });
    await kv.set(keyMoonPositions(mode), positions, { ex: 60 * 60 * 24 * 30 });
    await kv.set(keyMoonPortfolio(mode), portfolio, { ex: 60 * 60 * 24 * 30 });

    await saveMoonDiag(mode, diag);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  } finally {
    // 🔧 Lock expliciet verwijderen
    try {
      if (lock?.key) await kv.del(lock.key);
    } catch {}
  }
}