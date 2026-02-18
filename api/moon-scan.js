// /api/moon-scan.js
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

  isModeAllowedByBtc,
  calcPnlPct,
  hitStopOrTp,

  // DISCORD
  sendDiscord,
  webhookForMoonStage,
  webhookMoonPortfolio,
  fmtMoonLine,
} from "./_moon_core.js";

import {
  uid,
  pushEvent,
  readTrades,
  writeTrades,
  addPostWatch,
  pnlPctFromPrices,
} from "./_analytics.js";

export const config = RUNTIME_CONFIG;

const MAX_SNAPSHOTS = 3;
const POST_WATCH_HOURS = 24;

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
  const move2 = s2.price > 0 ? Math.abs((s3.price - s2.price) / s3.price) : 0;
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

async function openMoonTradeMirror({ mode, c, risk, confidence, obView, depthUsd }) {
  const trades = await readTrades("moon");

  // al open? (zelfde symbol + mode)
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

    // MOON gebruikt tp3 als “TP”
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
    (t) =>
      String(t.status) === "OPEN" &&
      String(t.mode) === String(mode) &&
      String(t.symbol) === String(symbol)
  );
  if (idx < 0) return;

  const t = trades[idx];

  t.status = "CLOSED";
  t.exitAt = now;
  t.exitPrice = Number(priceNow || t.entryPrice);
  t.exitReason = String(reason || "SELL");

  const pnl = pnlPctFromPrices({ mode: t.mode, entryPrice: t.entryPrice, priceNow: t.exitPrice });
  t.pnlPct = +Number(pnl || 0).toFixed(2);

  // post-watch starten (24h na close)
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

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";
    const now = Date.now();

    // 1) BTC gate
    const btc = await fetchBTCGateCached();
    const allowed = isModeAllowedByBtc(mode, btc.state);

    // stores
    const resetAt = (await kv.get(keyMoonReset(mode))) || 0;
    const state = (await kv.get(keyMoonState(mode))) || {};

    const positionsPrev = await kv.get(keyMoonPositions(mode));
    const positions = normalizePositionsStore(positionsPrev);

    // BTC flip -> close open positions (portfolio logic)
    if (!allowed && MOON.portfolio.closeOnBtcFlip && positions.open.length) {
      const cgNow = await fetchCoinGeckoTopCached();
      const priceMap = buildSymbolPriceMap(cgNow);

      const toClose = [...positions.open];
      positions.open = [];

      for (const t of toClose) {
        const px = priceMap.get(t.symbol) || Number(t.lastPrice || t.entryPrice || 0) || Number(t.entryPrice || 0);
        const pnlPct = calcPnlPct({ mode: t.mode, entryPrice: t.entryPrice, priceNow: px });
        const pnlUsd = (Number(t.posUsd || MOON.portfolio.posUsd) * pnlPct) / 100;

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

        // Mirror close naar analytics-trades
        await closeMoonTradeMirror({
          mode: t.mode,
          symbol: t.symbol,
          priceNow: px,
          reason: "BTC_GATE_FLIP",
        });

        const hook = webhookMoonPortfolio() || webhookForMoonStage("ELITE");
        if (hook) {
          const msg =
            `**${closedTrade.symbol}** → **SELL** (MOON ${String(closedTrade.mode).toUpperCase()})\n` +
            `Reason: BTC_GATE_FLIP\n` +
            `Exit: $${Number(closedTrade.exitPrice).toFixed(8)} | PnL: ${closedTrade.pnlPct >= 0 ? "+" : ""}${closedTrade.pnlPct}% ($${closedTrade.pnlUsd})`;
          await sendDiscord(hook, msg);
        }
      }
    }

    // blocked -> empty latest + portfolio
    if (!allowed) {
      const portfolio = calcPortfolioFromPositions(mode, positions);

      await kv.set(keyMoonPortfolio(mode), portfolio);
      await kv.set(keyMoonPositions(mode), positions);

      const result = {
        ok: true,
        ts: now,
        mode,
        btc,
        counts: { radar: 0, buildup: 0, almost: 0, elite: 0 },
        funnel: { elite: [], almost: [], buildup: [], radar: [] },
        portfolio,
        note:
          btc.state === "NEUTRAL"
            ? "Blocked: BTC is NEUTRAL → scans disabled."
            : mode === "bull"
              ? "Blocked: BTC is not BULL → bull scan disabled."
              : "Blocked: BTC is not BEAR → bear scan disabled.",
      };

      await kv.set(keyMoonLatest(mode), result);

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(result));
    }

    // 2) Universe
    const bitgetSet = await getBitgetSpotUsdtSymbols();
    const cg = await fetchCoinGeckoTopCached();

    // 3) Candidates
    const radarRaw = cg
      .filter((c) => bitgetSet.has(String(c.symbol || "").toUpperCase()))
      .filter((c) => passRadarMoon(c, mode))
      .slice(0, MOON.RADAR_LIMIT);

    // cleanup state
    const liveSyms = new Set(radarRaw.map((c) => c.symbol));
    for (const sym of Object.keys(state)) {
      if (!liveSyms.has(sym)) delete state[sym];
    }

    const radar = [];
    const buildup = [];
    const almost = [];
    const elite = [];

    const findOpen = (sym) => positions.open.find((t) => t.symbol === sym);
    const canOpenNew = () => positions.open.length < MOON.portfolio.maxOpen;

    for (const c of radarRaw) {
      const sym = c.symbol;

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

      // histories
      const priceHist = updatePriceHist(prev.priceHist, c.price);
      const volHist = updateVolHist(prev.volHist, c.volume);
      const volAcc = volAccFromHist(volHist);
      const flat60 = priceFlatPct(priceHist, 60);

      // OB
      const obRaw = await kv.get(keyMoonObResult(mode, sym));
      const obScore = Number(obRaw?.ob?.score ?? obRaw?.score ?? 0);

      const snapshot = { ts: now, price: c.price, volAcc, range24: c.range24, obScore };
      const snapshots = updateSnapshots(prev.snapshots, snapshot);
      const rolling = computeRollingMetrics(snapshots);

      const obView = obRaw
        ? {
            valid: !!obRaw.valid,
            stale: !!obRaw.stale,
            score: obScore,
            spreadPct: Number(obRaw?.ob?.spreadPct ?? 999),
            lor: Number(obRaw?.ob?.lor ?? 1),
            agree: Number(obRaw?.agree ?? 0),
            bidUsd: Number(obRaw?.ob?.bidUsd ?? 0),
            askUsd: Number(obRaw?.ob?.askUsd ?? 0),
            reason: String(obRaw?.reason || ""),
          }
        : null;

      const depthUsd = obView ? Math.min(obView.bidUsd, obView.askUsd) : 0;
      const floorUsd = depthFloorUsd(c.marketCap);
      const depthOk = depthUsd >= floorUsd;

      const confidence = computeConfidence({
        obScore,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc,
      });

      // Consistency (moon is simpel)
      const wantedSide = mode === "bull" ? "BULL" : "BEAR";
      const sideNow =
        mode === "bull" ? (c.change24 >= 0 ? "BULL" : "BEAR") : (c.change24 <= 0 ? "BEAR" : "BULL");
      const consistencyRatio = sideNow === wantedSide ? 1.0 : 0.0;

      // gates
      const buildupGate = passBuildupMoon({ c, volAcc });

      const almostGate = passAlmostMoon({
        priceHist,
        volAcc,
        confidence,
        consistencyRatio,
      });

      const eliteGate = passEliteMoon({
        mode,
        obView,
        confidence,
        consistencyRatio,
        depthUsd,
        floorUsd,
        range24: c.range24,
      });

      // Elite extra rolling sniper
      const rollCfg = MOON.elite.roll;
      const eliteExtra =
        rolling.deltaPrice15m <= rollCfg.maxDeltaPrice15mPct &&
        rolling.deltaVol15m >= rollCfg.minDeltaVol15m &&
        (!rollCfg.needCompression || rolling.compression) &&
        rolling.obSlope >= rollCfg.minObSlope &&
        rolling.obStability <= rollCfg.maxObStability;

      // stage keuze
      let stage = "RADAR";
      if (buildupGate.ok) stage = "BUILDUP";
      if (almostGate.ok) stage = "ALMOST";
      if (eliteGate.ok && eliteExtra) stage = "ELITE";

      const prevStage = String(prev.stage || "RADAR");
      const stageChanged = prevStage !== stage;

      // Risk model (SL/TP)
      const risk = computeMoonRisk({
        mode,
        price: c.price,
        range24: c.range24,
        confidence,
        depthOk,
      });

      // ======= Analytics: stage events =======
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
          },
        });
      }

      // ======= ENTRY/HOLD/SELL tracking (portfolio) =======
      let trade = findOpen(sym) || null;

      // open trade when Elite hits
      let openedNow = false;
      if (!trade && stage === "ELITE" && canOpenNew() && risk?.sl && risk?.tp3) {
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

        // Mirror open naar analytics-trades
        await openMoonTradeMirror({ mode, c, risk, confidence, obView, depthUsd });
      }

      // update open trade
      let closedNow = null;
      if (trade) {
        if (trade.status === "ENTRY") trade.status = "HOLD";

        trade.lastPrice = Number(c.price);

        // Mirror mfe/mae update
        await updateMoonTradeMfeMae({ mode, symbol: sym, priceNow: c.price });

        const pnlPct = calcPnlPct({ mode, entryPrice: trade.entryPrice, priceNow: c.price });
        const pnlUsd = (trade.posUsd * pnlPct) / 100;

        const hit = hitStopOrTp({ mode, priceNow: c.price, sl: trade.sl, tp3: trade.tp3 });

        if (hit.hit) {
          trade.status = "SELL";
          trade.exitAt = now;
          trade.exitPrice = Number(c.price);
          trade.exitReason = hit.kind; // SL or TP
          trade.pnlPct = +pnlPct.toFixed(2);
          trade.pnlUsd = +pnlUsd.toFixed(2);

          positions.open = positions.open.filter((t) => t.symbol !== sym);
          positions.closed.push(trade);

          closedNow = { ...trade };
          trade = { ...trade };

          // Mirror close naar analytics-trades + postwatch
          await closeMoonTradeMirror({
            mode,
            symbol: sym,
            priceNow: c.price,
            reason: hit.kind,
          });
        } else {
          trade.pnlPct = +pnlPct.toFixed(2);
          trade.pnlUsd = +pnlUsd.toFixed(2);
        }
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
        consistency: { ok: true, ratio: consistencyRatio, total: 1, same: consistencyRatio ? 1 : 0 },

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
          radar: "RADAR ok",
          buildup: buildupGate.why,
          almost: almostGate.why,
          elite: eliteGate.why,
          eliteExtra: eliteExtra ? "ROLLING ok" : "ROLLING fail",
        },
      };

      // Discord stage change
      if (stageChanged) {
        const hook = webhookForMoonStage(stage);
        if (hook) {
          const extra =
            `why: ${item.why.eliteExtra} | depth: $${Math.round(depthUsd)} (floor $${Math.round(floorUsd)})\n` +
            `rolling: ΔP15m ${Number(rolling.deltaPrice15m || 0).toFixed(2)}% | ΔV15m ${Number(rolling.deltaVol15m || 0).toFixed(2)} | slope ${Number(rolling.obSlope || 0).toFixed(2)}`;
          await sendDiscord(hook, fmtMoonLine(item, mode, extra));
        }
      }

      // Discord trade open
      if (openedNow) {
        const hook = webhookMoonPortfolio() || webhookForMoonStage("ELITE");
        if (hook) {
          const msg =
            `**${sym}** → **OPEN** (MOON ${mode.toUpperCase()})\n` +
            `Entry: $${Number(item.price).toFixed(8)} | SL: $${Number(item.risk?.sl || 0).toFixed(8)} | TP3: $${Number(item.risk?.tp3 || 0).toFixed(8)}\n` +
            `confidence: ${item.confidence}/100 | depthOk: ${item.depthOk ? "yes" : "no"}`;
          await sendDiscord(hook, msg);
        }
      }

      // Discord trade close (TP/SL)
      if (closedNow) {
        const hook = webhookMoonPortfolio() || webhookForMoonStage("ELITE");
        if (hook) {
          const msg =
            `**${closedNow.symbol}** → **SELL** (MOON ${String(closedNow.mode).toUpperCase()})\n` +
            `Reason: ${closedNow.exitReason}\n` +
            `Exit: $${Number(closedNow.exitPrice).toFixed(8)} | PnL: ${closedNow.pnlPct >= 0 ? "+" : ""}${closedNow.pnlPct}% ($${closedNow.pnlUsd})`;
          await sendDiscord(hook, msg);
        }
      }

      // store state
      state[sym] = {
        enteredAt: prev.enteredAt || now,
        stageAt: prev.stageAt || now,
        lastSeenAt: now,
        priceHist,
        volHist,
        snapshots,
        stage,
      };

      radar.push(item);
      if (stage === "BUILDUP") buildup.push(item);
      if (stage === "ALMOST") almost.push(item);
      if (stage === "ELITE") elite.push(item);
    }

    // sorting
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

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      counts: {
        radar: radar.length,
        buildup: buildup.length,
        almost: almost.length,
        elite: elite.length,
      },
      funnel: { elite, almost, buildup, radar },
      portfolio,
    };

    await kv.set(keyMoonLatest(mode), result);
    await kv.set(keyMoonState(mode), state);
    await kv.set(keyMoonPositions(mode), positions);
    await kv.set(keyMoonPortfolio(mode), portfolio);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}