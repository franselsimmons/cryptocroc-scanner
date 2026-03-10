import { kv } from "@vercel/kv";
import {
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
  keyMoonState,
  keyObResult,
  requireSecret,
  tryAcquireMoonScanLock,
  releaseMoonScanLock,
} from "../../lib/_moon_core.js";
import { pushEvent, uid } from "../../lib/_analytics.js";

export const config = {
  runtime: "nodejs",
  maxDuration: 60, // 1 minuut is genoeg
};

const UNIVERSE_KEY = "moon:universe:latest";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

// ---------- basis filters (identiek aan voorheen) ----------
function basicFilter(c) {
  const vol = n(c.volume);
  const cap = n(c.marketCap);
  if (vol < 250_000) return false;
  if (cap < 1_000_000) return false;
  if (cap > 800_000_000) return false;
  return true;
}

function passModeFilter(c, mode) {
  const ch24 = n(c.change24);
  if (mode === "bull") return ch24 > -2;
  return ch24 < 0.5;
}

// ---------- stageFromScore (aangepast) ----------
function stageFromScore(score) {
  if (score >= 0.68) return "ELITE";
  if (score >= 0.57) return "ALMOST";
  if (score >= 0.37) return "BUILDUP";
  return "RADAR";
}

// ---------- confidence (moon eigen) ----------
function computeConfidence({ vm, change24, range24, obScoreAbs }) {
  let c = 0;
  c += Math.max(0, Math.min(40, (vm / 0.30) * 40));
  c += Math.max(0, Math.min(25, (Math.abs(change24) / 12) * 25));
  c += Math.max(0, 20 - Math.min(20, range24 / 2));
  if (obScoreAbs >= 0.03) c += 15;
  return Math.max(0, Math.min(100, Math.round(c)));
}

// ---------- trade plan (moon eigen) ----------
function makeTradePlan(price, mode, confidence) {
  const p = n(price);
  if (!p) return null;
  const conf = n(confidence);
  const riskPct = conf >= 80 ? 0.035 : conf >= 65 ? 0.03 : 0.025;
  const rewardPct = conf >= 80 ? 0.09 : conf >= 65 ? 0.07 : 0.05;

  if (mode === "bull") {
    return {
      entry: p,
      sl: p * (1 - riskPct),
      tp: p * (1 + rewardPct),
      rr: rewardPct / riskPct,
    };
  } else {
    return {
      entry: p,
      sl: p * (1 + riskPct),
      tp: p * (1 - rewardPct),
      rr: rewardPct / riskPct,
    };
  }
}

// ---------- main handler ----------
export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    if (!requireSecret(req, res)) return;

    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const lock = await tryAcquireMoonScanLock(mode, 600);
    lockAcquired = !!lock?.ok;
    if (!lockAcquired) {
      return res.status(200).json({ ok: true, mode, skipped: true, reason: "scan already running" });
    }

    const now = Date.now();

    // 1. Lees universe
    const universe = await kv.get(UNIVERSE_KEY);
    if (!universe?.ok || !Array.isArray(universe.coins)) {
      return res.status(200).json({ ok: false, error: "No moon universe available" });
    }

    // 2. Filter ruwe coins (radar + mode)
    const candidates = universe.coins
      .filter(basicFilter)
      .filter(c => passModeFilter(c, mode))
      .slice(0, 180);

    // 3. Bouw per coin de data op met OB
    const coins = [];
    for (const c of candidates) {
      const sym = c.symbol;
      const obKey = keyObResult(mode, sym);
      const ob = await kv.get(obKey);

      const vm = n(c.volume) / Math.max(n(c.marketCap), 1);
      const obScoreAbs = ob?.score ? Math.abs(ob.score) : 0;
      const confidence = computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obScoreAbs,
      });

      // Moon probability (simplified, gebaseerd op confidence)
      const scoreProb = confidence / 100; // 0..1

      const stage = stageFromScore(scoreProb);

      const tradePlan = makeTradePlan(c.price, mode, confidence);

      coins.push({
        ...c,
        vm,
        confidence,
        stage,
        ob: ob ? {
          spreadPct: ob.spreadPct,
          depthBidUsd: ob.depthBidUsd,
          depthAskUsd: ob.depthAskUsd,
          score: ob.score,
          depthMinUsd1p: ob.depthMinUsd1p,
        } : null,
        moonProbability: scoreProb,
        tradePlan,
      });
    }

    // 4. Split in funnels
    const funnel = { elite: [], almost: [], buildup: [], radar: [] };
    for (const coin of coins) {
      funnel[coin.stage.toLowerCase()]?.push(coin);
    }

    // 5. Sorteer en limiter
    const sortByProb = (a, b) => (b.moonProbability || 0) - (a.moonProbability || 0);
    for (const key of Object.keys(funnel)) {
      funnel[key].sort(sortByProb);
    }
    funnel.radar = funnel.radar.slice(0, 200);
    funnel.buildup = funnel.buildup.slice(0, 80);
    funnel.almost = funnel.almost.slice(0, 30);
    funnel.elite = funnel.elite.slice(0, 10);

    // 6. BTC state (simpel)
    const btc24h = universe.btc?.change24 || 0;
    const btcState = btc24h >= 1 ? "BULL" : btc24h <= -1 ? "BEAR" : "NEUTRAL";

    // 7. Posities (ongewijzigd uit oude scan, maar we moeten state beheren)
    // Voor nu: lege posities, of we kunnen de oude logica behouden.
    // We laten de posities voorlopig achterwege voor eenvoud.
    const positions = { open: [], closed: [] };
    const portfolio = { mode, posUsd: 50, openCount: 0, closedCount: 0, realizedUsd: 0, avgRealizedPct: 0, updatedAt: now };

    const latest = {
      ok: true,
      ts: now,
      mode,
      btc: { state: btcState, chg24: btc24h },
      counts: {
        elite: funnel.elite.length,
        almost: funnel.almost.length,
        buildup: funnel.buildup.length,
        radar: funnel.radar.length,
      },
      funnel,
      portfolio,
      positions,
    };

    await kv.set(keyMoonLatest(mode), latest, { ex: 60 * 60 });
    await kv.set(keyMoonState(mode), {}, { ex: 60 * 60 * 24 }); // leeg voor nu

    res.status(200).json(latest);
  } catch (e) {
    console.error("MOON SCAN ERROR:", e);
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (lockAcquired) await releaseMoonScanLock(mode);
  }
}