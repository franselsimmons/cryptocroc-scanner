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
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

const MAX_SNAPSHOTS = 3;

function updateSnapshots(prevSnapshots, snapshot) {
  const arr = Array.isArray(prevSnapshots) ? [...prevSnapshots] : [];
  arr.push(snapshot);
  if (arr.length > MAX_SNAPSHOTS) arr.shift();
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

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";
    const now = Date.now();

    // 1) BTC gate
    const btc = await fetchBTCGateCached();

    // ✅ HARD BLOCK (A)
    const allowed = isModeAllowedByBtc(mode, btc.state);

    // load stores (ook als blocked: dan kunnen we posities sluiten bij flip)
    const resetAt = (await kv.get(keyMoonReset(mode))) || 0;
    const state = (await kv.get(keyMoonState(mode))) || {};

    const positionsPrev = await kv.get(keyMoonPositions(mode));
    const positions = normalizePositionsStore(positionsPrev);

    // Als BTC gate flip + closeOnBtcFlip => sluit alles direct
    if (!allowed && MOON.portfolio.closeOnBtcFlip && positions.open.length) {
      const stillOpen = [];
      for (const t of positions.open) {
        // sluit op huidige prijs onbekend => we markeren “forced exit” zonder pnl
        positions.closed.push({
          ...t,
          status: "SELL",
          exitReason: "BTC_GATE_FLIP",
          exitAt: now,
          exitPrice: t.entryPrice, // neutraal, want we hebben geen live prijs
          pnlPct: 0,
          pnlUsd: 0,
        });
      }
      positions.open = stillOpen;
    }

    // Als blocked: schrijf lege latest (zodat UI het snapt) + portfolio update
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
          mode === "bull"
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

    // helper: find open position
    const findOpen = (sym) => positions.open.find((t) => t.symbol === sym);

    // helper: open new position
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

      // OB result (sampler)
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

      // Consistency (nu “simpel maar echt”):
      // bull = change24 >= 0, bear = change24 <= 0
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

      // ✅ Elite extra (Rolling 15m sniper)
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

      // Risk model (SL/TP)
      const risk = computeMoonRisk({
        mode,
        price: c.price,
        range24: c.range24,
        confidence,
        depthOk,
      });

      // =============================
      // ENTRY/HOLD/SELL tracking
      // =============================
      let trade = findOpen(sym) || null;

      // 1) open trade when Elite hits
      if (!trade && stage === "ELITE" && canOpenNew() && risk?.sl && risk?.tp3) {
        const posUsd = MOON.portfolio.posUsd;
        const qty = posUsd / Number(c.price || 1);

        trade = {
          symbol: sym,
          mode,
          status: "ENTRY",      // volgende scans wordt HOLD
          entryAt: now,
          entryPrice: Number(c.price),
          qty: +qty.toFixed(8),
          sl: Number(risk.sl),
          tp3: Number(risk.tp3),
          posUsd,
          note: "Opened on ELITE",
        };
        positions.open.push(trade);
      }

      // 2) update open trade
      if (trade) {
        // Promote ENTRY -> HOLD
        if (trade.status === "ENTRY") trade.status = "HOLD";

        const pnlPct = calcPnlPct({ mode, entryPrice: trade.entryPrice, priceNow: c.price });
        const pnlUsd = (trade.posUsd * pnlPct) / 100;

        const hit = hitStopOrTp({ mode, priceNow: c.price, sl: trade.sl, tp3: trade.tp3 });

        if (hit.hit) {
          // close
          trade.status = "SELL";
          trade.exitAt = now;
          trade.exitPrice = Number(c.price);
          trade.exitReason = hit.kind; // SL or TP
          trade.pnlPct = +pnlPct.toFixed(2);
          trade.pnlUsd = +pnlUsd.toFixed(2);

          // move to closed
          positions.open = positions.open.filter((t) => t.symbol !== sym);
          positions.closed.push(trade);

          trade = { ...trade }; // for UI
        } else {
          // keep open
          trade.pnlPct = +pnlPct.toFixed(2);
          trade.pnlUsd = +pnlUsd.toFixed(2);
        }
      }

      const item = {
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
      (b.rolling?.deltaVol15m - a.rolling?.deltaVol15m) ||
      (b.volAcc - a.volAcc) ||
      (b.vm - a.vm);

    elite.sort(sortKey);
    almost.sort(sortKey);
    buildup.sort(sortKey);
    radar.sort((a, b) => (b.volAcc - a.volAcc) || (b.vm - a.vm));

    // portfolio
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