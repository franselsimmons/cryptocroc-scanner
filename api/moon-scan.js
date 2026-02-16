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

function minutesAgo(ts) {
  const t = Number(ts || 0);
  if (!t) return 999999;
  return (Date.now() - t) / 60000;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";
    const now = Date.now();

    // 1) BTC gate data (we tonen dit in UI; gate zelf kun je later weer “hard” maken)
    const btc = await fetchBTCGateCached();

    // 2) Universe: Bitget spot USDT symbols
    const bitgetSet = await getBitgetSpotUsdtSymbols();

    // 3) CoinGecko slice (cached) — pagina 5, 250 coins
    const cg = await fetchCoinGeckoTopCached();

    // 4) State (voor volAcc + rotatie)
    const resetAt = (await kv.get(keyMoonReset(mode))) || 0;
    const state = (await kv.get(keyMoonState(mode))) || {};

    // 5) Live candidates (Bitget filter + radar filter)
    const radarRaw = cg
      .filter((c) => bitgetSet.has(String(c.symbol || "").toUpperCase()))
      .filter((c) => passRadarMoon(c, mode))
      .slice(0, MOON.RADAR_LIMIT);

    // Cleanup “spook state”
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
        stage: "RADAR",
      };

      // Reset knop
      if (Number(prev.enteredAt || 0) < resetAt) {
        prev.enteredAt = now;
        prev.stageAt = now;
        prev.lastSeenAt = 0;
        prev.priceHist = [];
        prev.volHist = [];
        prev.stage = "RADAR";
      }

      // Rotatie (alleen voor “hangers”)
      const ageMin = minutesAgo(prev.stageAt || prev.enteredAt || now);
      if (prev.stage === "BUILDUP" && ageMin > MOON.buildupMaxAgeMin) {
        prev.stage = "RADAR";
        prev.stageAt = now;
      }
      if (prev.stage === "ALMOST" && ageMin > MOON.almostMaxAgeMin) {
        prev.stage = "BUILDUP";
        prev.stageAt = now;
      }

      // histories
      const priceHist = updatePriceHist(prev.priceHist, c.price);
      const volHist = updateVolHist(prev.volHist, c.volume);
      const volAcc = volAccFromHist(volHist);
      const flat60 = priceFlatPct(priceHist, 60);

      // OB view (als sampler al liep)
      const obRaw = await kv.get(keyMoonObResult(mode, sym));
      const obView = obRaw
        ? {
            valid: !!obRaw.valid,
            stale: !!obRaw.stale,
            score: Number(obRaw?.ob?.score ?? obRaw?.score ?? obRaw?.avgScore ?? 0),
            spreadPct: Number(obRaw?.ob?.spreadPct ?? obRaw?.spreadPct ?? 999),
            lor: Number(obRaw?.ob?.lor ?? obRaw?.lor ?? 1),
            agree: Number(obRaw?.agree ?? 0),
            bidUsd: Number(obRaw?.ob?.bidUsd ?? 0),
            askUsd: Number(obRaw?.ob?.askUsd ?? 0),
            reason: String(obRaw?.reason || ""),
          }
        : null;

      // depth
      const depthUsd = obView ? Math.min(obView.bidUsd || 0, obView.askUsd || 0) : 0;
      const floorUsd = depthFloorUsd(c.marketCap);
      const depthOk = depthUsd >= floorUsd;

      // confidence (werkt ook als obView null is: obScore=0)
      const confidence = computeConfidence({
        obScore: obView?.score ?? 0,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc,
      });

      // Consistency (voor nu simpel: bull => change24 >=0, bear => change24 <=0)
      // (Als je later sideHist terug wil, kan dat; maar dit is “works-now”.)
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

      // stage keuze (proactief)
      let stage = "RADAR";
      if (buildupGate.ok) stage = "BUILDUP";
      if (almostGate.ok) stage = "ALMOST";
      if (eliteGate.ok) stage = "ELITE";

      // risk (altijd tonen; note zegt of depth ok is)
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
        consistency: { ok: true, ratio: consistencyRatio, total: 1, same: consistencyRatio ? 1 : 0 },

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
              reason: obView.reason,
            }
          : { status: "none" },

        depthUsd,
        floorUsd,
        depthOk,

        risk, // ✅ SL/TP hier

        why: {
          radar: "RADAR ok",
          buildup: buildupGate.why,
          almost: almostGate.why,
          elite: eliteGate.why,
        },
      };

      // store state
      state[sym] = {
        enteredAt: item.enteredAt,
        stageAt: item.stageAt,
        lastSeenAt: now,
        priceHist,
        volHist,
        stage,
      };

      // push to lists
      radar.push(item);
      if (stage === "BUILDUP") buildup.push(item);
      if (stage === "ALMOST") almost.push(item);
      if (stage === "ELITE") elite.push(item);
    }

    // sorting (kwaliteit bovenaan)
    const sortKey = (a, b) =>
      (b.confidence - a.confidence) ||
      (b.volAcc - a.volAcc) ||
      (b.vm - a.vm);

    elite.sort(sortKey);
    almost.sort(sortKey);
    buildup.sort(sortKey);

    // radar: meest “interessant” bovenaan
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
      funnel: {
        elite,
        almost,
        buildup,
        radar,
      },
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