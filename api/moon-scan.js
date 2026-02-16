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
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

const MAX_SNAPSHOTS = 3;

function minutesAgo(ts) {
  const t = Number(ts || 0);
  if (!t) return 999999;
  return (Date.now() - t) / 60000;
}

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

  const deltaPrice15m =
    ((s3.price - s1.price) / s1.price) * 100;

  const deltaVol15m =
    s3.volAcc - s1.volAcc;

  const compression =
    s3.range24 < s2.range24 &&
    s2.range24 < s1.range24;

  const slope1 = s2.obScore - s1.obScore;
  const slope2 = s3.obScore - s2.obScore;
  const obSlope = (slope1 + slope2) / 2;

  const scores = snaps.map(s => s.obScore);
  const mean = scores.reduce((a,b)=>a+b,0)/scores.length;
  const variance =
    scores.reduce((a,b)=>a+Math.pow(b-mean,2),0)/scores.length;
  const obStability = Math.sqrt(variance);

  const move1 = Math.abs((s2.price - s1.price)/s1.price);
  const move2 = Math.abs((s3.price - s2.price)/s2.price);
  const atrEst = (move1 + move2)/2;

  return {
    deltaPrice15m,
    deltaVol15m,
    compression,
    obSlope,
    obStability,
    atrEst,
  };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";
    const now = Date.now();

    const btc = await fetchBTCGateCached();
    const bitgetSet = await getBitgetSpotUsdtSymbols();
    const cg = await fetchCoinGeckoTopCached();

    const resetAt = (await kv.get(keyMoonReset(mode))) || 0;
    const state = (await kv.get(keyMoonState(mode))) || {};

    const radarRaw = cg
      .filter((c) => bitgetSet.has(String(c.symbol || "").toUpperCase()))
      .filter((c) => passRadarMoon(c, mode))
      .slice(0, MOON.RADAR_LIMIT);

    const liveSyms = new Set(radarRaw.map((c) => c.symbol));
    for (const sym of Object.keys(state)) {
      if (!liveSyms.has(sym)) delete state[sym];
    }

    const radar = [];
    const buildup = [];
    const almost = [];
    const elite = [];

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

      const priceHist = updatePriceHist(prev.priceHist, c.price);
      const volHist = updateVolHist(prev.volHist, c.volume);
      const volAcc = volAccFromHist(volHist);
      const flat60 = priceFlatPct(priceHist, 60);

      const obRaw = await kv.get(keyMoonObResult(mode, sym));
      const obScore = Number(obRaw?.ob?.score ?? obRaw?.score ?? 0);

      const snapshot = {
        ts: now,
        price: c.price,
        volAcc,
        range24: c.range24,
        obScore,
      };

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

      const buildupGate = passBuildupMoon({ c, volAcc });
      const almostGate = passAlmostMoon({
        priceHist,
        volAcc,
        confidence,
        consistencyRatio: 1,
      });

      let eliteExtra =
        rolling.deltaPrice15m <= 4 &&
        rolling.deltaVol15m > 0.15 &&
        rolling.compression &&
        rolling.obSlope > 8 &&
        rolling.obStability < 20;

      const eliteGate = passEliteMoon({
        mode,
        obView,
        confidence,
        consistencyRatio: 1,
        depthUsd,
        floorUsd,
        range24: c.range24,
      });

      let stage = "RADAR";
      if (buildupGate.ok) stage = "BUILDUP";
      if (almostGate.ok) stage = "ALMOST";
      if (eliteGate.ok && eliteExtra) stage = "ELITE";

      const risk = computeMoonRisk({
        mode,
        price: c.price,
        range24: c.range24,
        confidence,
        depthOk,
      });

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
        enteredAt: Number(prev.enteredAt || now),
        stageAt: Number(prev.stageAt || now),

        volAcc: +Number(volAcc || 1).toFixed(3),
        priceFlat60: +Number(flat60 || 0).toFixed(2),

        confidence,

        rolling,

        ob: obView || { status: "none" },

        depthUsd,
        floorUsd,
        depthOk,

        risk,
      };

      state[sym] = {
        enteredAt: item.enteredAt,
        stageAt: item.stageAt,
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

    const sortKey = (a, b) =>
      (b.confidence - a.confidence) ||
      (b.volAcc - a.volAcc) ||
      (b.vm - a.vm);

    elite.sort(sortKey);
    almost.sort(sortKey);
    buildup.sort(sortKey);
    radar.sort((a, b) => (b.volAcc - a.volAcc) || (b.vm - a.vm));

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
    };

    await kv.set(keyMoonLatest(mode), result);
    await kv.set(keyMoonState(mode), state);

    res.status(200).json(result);

  } catch (e) {
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}