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

// Rolling window: 3 snapshots = ~15 min (bij scan elke 5 min)
const MAX_SNAPSHOTS = 3;

function minutesAgo(ts) {
  const t = Number(ts || 0);
  if (!t) return 999999;
  return (Date.now() - t) / 60000;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function updateSnapshots(prevSnapshots, snapshot) {
  const arr = Array.isArray(prevSnapshots) ? [...prevSnapshots] : [];
  arr.push(snapshot);
  while (arr.length > MAX_SNAPSHOTS) arr.shift();
  return arr;
}

/**
 * Rolling metrics (15m):
 * - deltaPrice15m: prijs % verandering over window (moet klein blijven voor “vroeg”)
 * - deltaVolAcc15m: verschil in volAcc (moet omhoog: druk neemt toe)
 * - compression: range24 daalt 3x op rij (coiled spring)
 * - obSlopeLocal: slope uit snapshots (ruis, maar handig)
 * - obStabilityLocal: std op snapshots (ruis, maar handig)
 * - atrEst: simpele “mini ATR” uit prijs moves (voor debug / later risk tuning)
 */
function computeRollingMetrics(snaps) {
  if (!Array.isArray(snaps) || snaps.length < 3) {
    return {
      ok: false,
      deltaPrice15m: 0,
      deltaVolAcc15m: 0,
      compression: false,
      obSlopeLocal: 0,
      obStabilityLocal: 0,
      atrEst: 0,
    };
  }

  const [s1, s2, s3] = snaps;

  const p1 = Number(s1.price || 0);
  const p2 = Number(s2.price || 0);
  const p3 = Number(s3.price || 0);

  const deltaPrice15m = p1 > 0 ? ((p3 - p1) / p1) * 100 : 0;

  const v1 = Number(s1.volAcc || 1);
  const v3 = Number(s3.volAcc || 1);
  const deltaVolAcc15m = v3 - v1;

  const r1 = Number(s1.range24 || 0);
  const r2 = Number(s2.range24 || 0);
  const r3 = Number(s3.range24 || 0);
  const compression = (r3 < r2) && (r2 < r1);

  // obScore is -1..+1, dus slope is klein (0.01..0.10 typisch)
  const o1 = Number(s1.obScore || 0);
  const o2 = Number(s2.obScore || 0);
  const o3 = Number(s3.obScore || 0);
  const obSlopeLocal = ((o2 - o1) + (o3 - o2)) / 2;

  const scores = [o1, o2, o3];
  const mean = (scores[0] + scores[1] + scores[2]) / 3;
  const variance =
    (Math.pow(scores[0] - mean, 2) + Math.pow(scores[1] - mean, 2) + Math.pow(scores[2] - mean, 2)) / 3;
  const obStabilityLocal = Math.sqrt(variance);

  // mini ATR schatting (gemiddelde absolute % move)
  const move1 = p1 > 0 ? Math.abs((p2 - p1) / p1) : 0;
  const move2 = p2 > 0 ? Math.abs((p3 - p2) / p2) : 0;
  const atrEst = (move1 + move2) / 2;

  return {
    ok: true,
    deltaPrice15m: +deltaPrice15m.toFixed(2),
    deltaVolAcc15m: +deltaVolAcc15m.toFixed(3),
    compression: !!compression,
    obSlopeLocal: +obSlopeLocal.toFixed(4),
    obStabilityLocal: +obStabilityLocal.toFixed(4),
    atrEst: +atrEst.toFixed(4),
  };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";
    const now = Date.now();

    // 1) BTC context
    const btc = await fetchBTCGateCached();

    // 2) Universe filter (Bitget spot USDT)
    const bitgetSet = await getBitgetSpotUsdtSymbols();

    // 3) CoinGecko slice (250 coins vanaf pagina 5)
    const cg = await fetchCoinGeckoTopCached();

    // 4) State
    const resetAt = (await kv.get(keyMoonReset(mode))) || 0;
    const state = (await kv.get(keyMoonState(mode))) || {};

    // 5) RADAR instroom
    const radarRaw = cg
      .filter((c) => bitgetSet.has(String(c.symbol || "").toUpperCase()))
      .filter((c) => passRadarMoon(c, mode))
      .slice(0, MOON.RADAR_LIMIT);

    // Cleanup state: coins die niet meer in radar zitten weggooien
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

      // Reset knop
      if (Number(prev.enteredAt || 0) < resetAt) {
        prev.enteredAt = now;
        prev.stageAt = now;
        prev.lastSeenAt = 0;
        prev.priceHist = [];
        prev.volHist = [];
        prev.snapshots = [];
        prev.stage = "RADAR";
      }

      // Rotatie (hangers)
      const ageMin = minutesAgo(prev.stageAt || prev.enteredAt || now);
      if (prev.stage === "BUILDUP" && ageMin > MOON.buildupMaxAgeMin) {
        prev.stage = "RADAR";
        prev.stageAt = now;
      }
      if (prev.stage === "ALMOST" && ageMin > MOON.almostMaxAgeMin) {
        prev.stage = "BUILDUP";
        prev.stageAt = now;
      }

      // Histories
      const priceHist = updatePriceHist(prev.priceHist, c.price);
      const volHist = updateVolHist(prev.volHist, c.volume);
      const volAcc = volAccFromHist(volHist);
      const flat60 = priceFlatPct(priceHist, 60);

      // OB result (rolling sampler)
      const obRaw = await kv.get(keyMoonObResult(mode, sym));

      // ObScore (-1..+1)
      const obScore = Number(obRaw?.ob?.score ?? obRaw?.avgScore ?? obRaw?.score ?? 0);

      // Snapshot (rolling 15m)
      const snapshot = {
        ts: now,
        price: Number(c.price || 0),
        volAcc: Number(volAcc || 1),
        range24: Number(c.range24 || 0),
        obScore: Number(obScore || 0),
      };
      const snapshots = updateSnapshots(prev.snapshots, snapshot);
      const rolling = computeRollingMetrics(snapshots);

      // OB view voor gates
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

            // rolling quality
            slope: Number(obRaw?.slope ?? 0),
            stable: obRaw?.stable === false ? false : true,
            stabilityStd: Number(obRaw?.stabilityStd ?? 0),

            reason: String(obRaw?.reason || ""),
          }
        : null;

      // Depth gate inputs
      const depthUsd = obView ? Math.min(Number(obView.bidUsd || 0), Number(obView.askUsd || 0)) : 0;
      const floorUsd = depthFloorUsd(c.marketCap);
      const depthOk = depthUsd >= floorUsd;

      // Confidence (werkt zonder OB ook, maar met OB wordt hij beter)
      const confidence = computeConfidence({
        obScore: obView?.score ?? 0,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc,
      });

      // Consistency: simpel “works-now”
      const wantedSide = mode === "bull" ? "BULL" : "BEAR";
      const sideNow =
        mode === "bull" ? (c.change24 >= 0 ? "BULL" : "BEAR") : (c.change24 <= 0 ? "BEAR" : "BULL");
      const consistencyRatio = sideNow === wantedSide ? 1.0 : 0.0;

      // Stage gates uit core
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

      // =========================
      // EXTRA ELITE LOGICA (9.7)
      // =========================
      // Let op: OB-score is klein (-1..+1), slope is ook klein (~0.00..0.10).
      // Dit is dus NIET "obSlope > 8" maar bv "obSlope > 0.01".
      const rollingOk =
        rolling.ok &&
        // prijs mag nog niet ontploffen (vroeg)
        rolling.deltaPrice15m <= 4.0 &&
        // druk neemt toe
        rolling.deltaVolAcc15m >= 0.08 &&
        // compressie helpt “coiled spring”
        rolling.compression === true;

      const obOk =
        !!obView &&
        obView.valid === true &&
        obView.stale === false &&
        obView.stable === true &&
        // bull: slope positief, bear: slope negatief
        (mode === "bull" ? obView.slope >= 0.01 : obView.slope <= -0.01) &&
        // stabilityStd laag = niet spiky
        Number(obView.stabilityStd || 0) <= 0.12;

      // Extra “niet te laat” + “geen dood ding”
      const notLate =
        Number(c.range24 || 0) <= Number(MOON?.elite?.range24Max || 18);

      // Elite extra = alles samen
      const eliteExtra = rollingOk && obOk && depthOk && notLate;

      // Stage keuze
      let stage = "RADAR";
      if (buildupGate.ok) stage = "BUILDUP";
      if (almostGate.ok) stage = "ALMOST";
      if (eliteGate.ok && eliteExtra) stage = "ELITE";

      // StageAt correct updaten als stage verandert
      let stageAt = Number(prev.stageAt || now);
      if (String(prev.stage || "RADAR") !== String(stage)) {
        stageAt = now;
      }

      // Risk (SL/TP) — blijft uit core
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
        stageAt,

        volAcc: +Number(volAcc || 1).toFixed(3),
        priceFlat60: +Number(flat60 || 0).toFixed(2),

        confidence,
        consistency: { ok: true, ratio: consistencyRatio, total: 1, same: consistencyRatio ? 1 : 0 },

        rolling,

        ob: obView
          ? {
              status: obView.valid ? "valid" : "validating",
              valid: obView.valid,
              stale: obView.stale,
              score: obView.score,
              spreadPct: obView.spreadPct,
              lor: obView.lor,
              agree: obView.agree,
              bidUsd: obView.bidUsd,
              askUsd: obView.askUsd,
              slope: obView.slope,
              stable: obView.stable,
              stabilityStd: obView.stabilityStd,
              reason: obView.reason,
            }
          : { status: "none" },

        depthUsd,
        floorUsd,
        depthOk,

        risk,

        why: {
          radar: "RADAR ok",
          buildup: buildupGate.why,
          almost: almostGate.why,
          elite: eliteGate.why,
          eliteExtra: {
            rollingOk,
            obOk,
            depthOk,
            notLate,
          },
        },
      };

      // Store state
      state[sym] = {
        enteredAt: item.enteredAt,
        stageAt: item.stageAt,
        lastSeenAt: now,
        priceHist,
        volHist,
        snapshots,
        stage,
      };

      // Push to lists
      radar.push(item);
      if (stage === "BUILDUP") buildup.push(item);
      if (stage === "ALMOST") almost.push(item);
      if (stage === "ELITE") elite.push(item);
    }

    // Sorting
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

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}