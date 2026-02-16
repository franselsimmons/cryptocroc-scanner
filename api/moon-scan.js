// /api/moon-scan.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  MOON,
  keyMoonLatest,
  fetchBTCGateCached,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
  passRadarMoon,
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

// ===============================
// TP/SL techniek (werkt altijd)
// ===============================
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function computeConfidenceLite({ vm, range24, absChg24, btc }) {
  // 0..100 (simpel maar bruikbaar)
  const vmS = clamp((Number(vm || 0) - 0.10) / (0.35 - 0.10), 0, 1);
  const rgS = clamp((Number(range24 || 0) - 2) / (12 - 2), 0, 1);
  const chS = clamp((Number(absChg24 || 0) - 1) / (6 - 1), 0, 1);
  const btcS = clamp((Math.abs(Number(btc?.chg24 || 0)) - 0.6) / (2.5 - 0.6), 0, 1);

  const score = 35 * vmS + 25 * rgS + 25 * chS + 15 * btcS;
  return Math.round(clamp(score, 0, 100));
}

function computeRisk({ mode, price, range24, confidence, stage }) {
  const p = Number(price || 0);
  if (!(p > 0)) return null;

  // Basis SL% komt uit volatiliteit (24h range)
  // Moon = wat agressiever dan main, maar wel clampen
  let slPct = clamp(Number(range24 || 0) * 0.30, 2.0, 12.0); // 2%..12%

  // Confidence: hoger = strakker, lager = ruimer
  const conf = clamp(Number(confidence || 0), 0, 100);
  const confAdj = (conf - 50) / 100; // -0.50..+0.50
  slPct *= (1 - confAdj);           // conf 80 => *0.70, conf 40 => *1.10

  // Stage: BUILDUP iets ruimer, ELITE strakker
  let stageMul = 1.0;
  if (stage === "BUILDUP") stageMul = 1.15;
  if (stage === "ALMOST")  stageMul = 1.00;
  if (stage === "ELITE")   stageMul = 0.85;
  slPct *= stageMul;

  slPct = clamp(slPct, 1.5, 15.0);

  const slDist = (slPct / 100) * p;

  // R-multiples (moonshots)
  const R1 = 1.5, R2 = 2.5, R3 = 4.0;

  let sl, tp1, tp2, tp3;
  if (mode === "bull") {
    sl  = p - slDist;
    tp1 = p + slDist * R1;
    tp2 = p + slDist * R2;
    tp3 = p + slDist * R3;
  } else {
    // short
    sl  = p + slDist;
    tp1 = p - slDist * R1;
    tp2 = p - slDist * R2;
    tp3 = p - slDist * R3;
  }

  return {
    slPct: Number(slPct.toFixed(2)),
    sl: Number(sl.toFixed(8)),
    tp1: Number(tp1.toFixed(8)),
    tp2: Number(tp2.toFixed(8)),
    tp3: Number(tp3.toFixed(8)),
    rMultiples: [R1, R2, R3],
    debug: { confAdj: Number(confAdj.toFixed(2)), stageMul },
  };
}

export default async function handler(req, res) {
  try {
    // ✅ beveiliging (token of x-vercel-cron)
    if (!requireSecret(req, res)) return;

    const modeRaw = String(req.query?.mode || "bull").toLowerCase();
    const mode = modeRaw === "bear" ? "bear" : "bull";

    // ===============================
    // 1) BTC GATE (cached)
    // ===============================
    const btc = await fetchBTCGateCached(); // { state, chg24, range24 }

    // Optioneel: als je wilt dat moon alleen draait als BTC dezelfde kant op staat
    // (nu laten we altijd door, maar je ziet BTC state in UI)
    // const wanted = mode === "bull" ? "BULL" : "BEAR";
    // if (btc.state !== wanted) ...

    // ===============================
    // 2) COINGECKO SLICE
    // ===============================
    const cg = await fetchCoinGeckoTopCached(); // gebruikt MOON.CG_START_PAGE/CG_PER_PAGE/CG_PAGES

    // ===============================
    // 3) BITGET SPOT USDT SYMBOLS
    // ===============================
    const bitgetSet = await getBitgetSpotUsdtSymbols();

    // ===============================
    // 4) RADAR (moon radar filter)
    // ===============================
    const radarBase = cg
      .filter((c) => bitgetSet.has(String(c.symbol || "").toUpperCase()))
      .filter((c) => passRadarMoon(c, mode))
      .slice(0, MOON.RADAR_LIMIT);

    // ===============================
    // 5) BUILDUP / ALMOST / ELITE (simpel, zonder OB)
    // ===============================
    const buildupBase = radarBase.filter((c) => Math.abs(Number(c.change24 || 0)) >= 1.5);

    const almostBase = buildupBase.filter((c) => {
      const vm = Number(c.vm || 0);
      const rng = Number(c.range24 || 0);
      const chg = Math.abs(Number(c.change24 || 0));
      return vm >= 0.20 && chg >= 2.0 && rng >= 4.0;
    });

    const eliteBase = almostBase.filter((c) => {
      const vm = Number(c.vm || 0);
      const chg = Math.abs(Number(c.change24 || 0));
      return vm >= 0.28 && chg >= 3.0;
    });

    // ===============================
    // 6) Verrijk coins met confidence + SL/TP + why
    // ===============================
    function enrich(c, stage) {
      const vm = Number(c.vm || 0);
      const rng = Number(c.range24 || 0);
      const absChg = Math.abs(Number(c.change24 || 0));

      const confidence = computeConfidenceLite({ vm, range24: rng, absChg24: absChg, btc });

      const risk = computeRisk({
        mode,
        price: c.price,
        range24: rng,
        confidence,
        stage,
      });

      // simpele “why” tekst zodat je snapt waarom hij waar staat
      const why = {
        radar: `mcap ${Math.round(Number(c.marketCap || 0)).toLocaleString()} • vol ${Math.round(Number(c.volume || 0)).toLocaleString()} • vm ${vm.toFixed(2)} • range24 ${rng.toFixed(2)}%`,
        buildup: absChg >= 1.5 ? `abs chg24 ${absChg.toFixed(2)}% >= 1.5%` : `abs chg24 te laag`,
        almost:
          vm >= 0.20 && absChg >= 2.0 && rng >= 4.0
            ? `vm ${vm.toFixed(2)} • chg ${absChg.toFixed(2)} • range ${rng.toFixed(2)}`
            : `almost voorwaarden niet compleet`,
        elite:
          vm >= 0.28 && absChg >= 3.0
            ? `vm ${vm.toFixed(2)} • chg ${absChg.toFixed(2)}`
            : `elite voorwaarden niet compleet`,
      };

      return {
        ...c,
        stage,
        confidence,
        consistency: { ok: false, ratio: 0, total: 0, same: 0 }, // later door state/OB te upgraden
        volAcc: 1.0, // later
        ob: { status: "none" }, // later door moon-ob-sampler
        depthOk: false,
        floorUsd: 0,
        risk,
        why: {
          almost: why.almost,
          elite: why.elite,
          radar: why.radar,
          buildup: why.buildup,
        },
      };
    }

    const radar = radarBase.map((c) => enrich(c, "RADAR"));
    const buildup = buildupBase.map((c) => enrich(c, "BUILDUP"));
    const almost = almostBase.map((c) => enrich(c, "ALMOST"));
    const elite = eliteBase.map((c) => enrich(c, "ELITE"));

    // ===============================
    // 7) RESULT OBJECT (exact wat moon.js verwacht)
    // ===============================
    const result = {
      ok: true,
      ts: Date.now(),
      mode,
      btc,
      counts: {
        radar: radar.length,
        buildup: buildup.length,
        almost: almost.length,
        elite: elite.length,
      },
      funnel: {
        radar,
        buildup,
        almost,
        elite,
      },
    };

    // ✅ juiste key (moon-latest leest exact deze)
    await kv.set(keyMoonLatest(mode), result);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}