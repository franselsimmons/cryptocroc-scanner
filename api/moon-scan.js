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
  keyMoonObSamples,
  keyMoonEliteLog,

  fetchCoinGeckoTopCached,
  fetchBTCGateCached,
  getBitgetSpotUsdtSymbols,

  updatePriceHist,
  updateSideHistory,
  calcConsistency,
  priceFlatPct,

  computeConfidence,

  passRadarMoon,
  passAlmostMoon,
  passEliteMoon,

  calcObSlope,
  depthFloorUsd,
  moonWebhookForStage,
  sendDiscord,
  fmtMoonLine,
  stageRank,
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

function coinSideFromMode(mode, change24) {
  if (mode === "bull") return change24 >= 0 ? "BULL" : "BEAR";
  return change24 <= 0 ? "BEAR" : "BULL";
}

async function bestEffortEliteLog(obj) {
  try {
    if (typeof kv.lpush === "function") {
      await kv.lpush(keyMoonEliteLog, JSON.stringify(obj));
      if (typeof kv.ltrim === "function") await kv.ltrim(keyMoonEliteLog, 0, 800);
    } else {
      await kv.set(`moon:elite:${obj.ts}:${obj.mode}:${obj.symbol}`, obj, { ex: 60 * 60 * 24 * 30 });
    }
  } catch {}
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = (req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    const now = Date.now();

    // BTC gate
    const btc = await fetchBTCGateCached();
    const wanted = mode === "bull" ? "BULL" : "BEAR";
    if (btc.state !== wanted) {
      const empty = {
        ok: true,
        ts: now,
        mode,
        btc,
        counts: { elite: 0, almost: 0, buildup: 0 },
        funnel: { elite: [], almost: [], buildup: [] },
        note: `BTC gate: ${btc.state} (needed ${wanted})`,
      };
      await kv.set(keyMoonLatest(mode), empty);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(empty));
    }

    // Universe (Bitget spot USDT)
    const symbolsSet = await getBitgetSpotUsdtSymbols();

    // CoinGecko top 250 (cached)
    const all = await fetchCoinGeckoTopCached();
    const rawCoins = all.filter((c) => symbolsSet.has(c.symbol));

    // KV state
    const resetAt = (await kv.get(keyMoonReset(mode))) || 0;
    const state = (await kv.get(keyMoonState(mode))) || {};

    const buildup = [];
    const almost = [];
    const elite = [];

    for (const c of rawCoins) {
      const sym = c.symbol;

      // per-coin state (moon)
      const prev = state[sym] || {
        stage: "BUILDUP",
        stageScans: 0,
        enteredAt: now,
        priceHist: [],
        volHist: [],
        sideHist: [],
        depthOk: false, // hysteresis status
      };

      // reset?
      const wasReset = Number(prev.enteredAt || 0) < resetAt;
      if (wasReset) {
        prev.stage = "BUILDUP";
        prev.stageScans = 0;
        prev.enteredAt = now;
        prev.priceHist = [];
        prev.volHist = [];
        prev.sideHist = [];
        prev.depthOk = false;
      }

      // RADAR pass?
      if (!passRadarMoon(c, mode)) {
        delete state[sym];
        continue;
      }

      // histories
      const priceHist = updatePriceHist(prev.priceHist, c.price);

      const volHist = Array.isArray(prev.volHist) ? prev.volHist.slice(-5) : [];
      volHist.push(c.volume);

      // volAcc proxy (last3 / prev3)
      const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
      const last3 = volHist.slice(-3);
      const prev3 = volHist.slice(-6, -3);
      const volAcc = prev3.length ? (sum(last3) / Math.max(1, sum(prev3))) : 1.0;

      // consistency
      const wantedSide = mode === "bull" ? "BULL" : "BEAR";
      const sideNow = coinSideFromMode(mode, c.change24);
      const sideHist = updateSideHistory(prev.sideHist, sideNow);
      const cons = calcConsistency(sideHist, wantedSide, 120, 6);

      // OB result
      const obRaw = await kv.get(keyMoonObResult(mode, sym));
      const obView = obRaw
        ? {
            valid: !!obRaw.valid,
            stale: !!obRaw.stale,
            score: Number(obRaw?.ob?.score ?? obRaw?.avgScore ?? 0),
            spreadPct: Number(obRaw?.ob?.spreadPct ?? 999),
            lor: Number(obRaw?.ob?.lor ?? 1),
            agree: Number(obRaw?.agree ?? 0),
            bidUsd: Number(obRaw?.ob?.bidUsd ?? 0),
            askUsd: Number(obRaw?.ob?.askUsd ?? 0),
            reason: obRaw?.reason || "",
          }
        : null;

      // slope
      let obSlope = null;
      if (MOON.elite.obSlopeEnabled) {
        const samples = await kv.get(keyMoonObSamples(mode, sym));
        obSlope = calcObSlope(samples);
      }

      // confidence
      const conf = computeConfidence({
        obScore: obView?.score ?? 0,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc,
      });

      // depth floor (uses bid/ask depth within 0.2%)
      const depthUsd = obView ? Math.min(obView.bidUsd || 0, obView.askUsd || 0) : 0;
      const floorUsd = depthFloorUsd(c.marketCap);

      // stage checks
      const almostGate = passAlmostMoon({
        priceHist,
        volAcc,
        confidence: conf,
        consistencyRatio: cons.ratio || 0,
      });

      const eliteGate = passEliteMoon({
        mode,
        obView,
        obSlope,
        confidence: conf,
        consistencyRatio: cons.ratio || 0,
        depthUsd,
        floorUsd,
        depthWasOk: !!prev.depthOk,
      });

      // desired stage
      let desired = "BUILDUP";
      if (eliteGate.ok) desired = "ELITE";
      else if (almostGate.ok) desired = "ALMOST";

      // stage update (no skip)
      let stage = prev.stage || "BUILDUP";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);

      const prevRank = stageRank(stage);
      const desiredRank = stageRank(desired);

      let nextStage = stage;
      if (desiredRank > prevRank) {
        if (stageScans >= MOON.minScansPerStage) {
          // stap voor stap omhoog
          nextStage = prevRank === 1 ? "ALMOST" : "ELITE";
        }
      } else if (desiredRank < prevRank) {
        nextStage = desired;
      }

      let stageChanged = false;
      if (nextStage === stage) {
        stageScans += 1;
      } else {
        stage = nextStage;
        stageScans = 1;
        enteredAt = now;
        stageChanged = true;
      }

      // hysteresis state bijhouden (alleen als obView bestaat)
      let depthOk = !!prev.depthOk;
      if (MOON.elite.depthFloorEnabled && obView) {
        // als hij eliteGate ok is => depthOk true
        // anders kan hij true blijven via hysteresis exit floor
        depthOk = eliteGate.ok || depthOk;
        // als depth heel laag is onder exitFloor -> force false
        const exitNeed = floorUsd * MOON.elite.depthHysteresisExitMul;
        if (depthUsd < exitNeed) depthOk = false;
      }

      // discord bij stage change
      if (stageChanged) {
        const hook = moonWebhookForStage(stage);
        if (hook) {
          const flat = priceFlatPct(priceHist, 60);
          const extra =
            `Confidence: ${conf}/100\n` +
            `Cons: ${Math.round((cons.ratio || 0) * 100)}% (${cons.same}/${cons.total})\n` +
            `VolAcc: ${volAcc.toFixed(2)} | Flat(60m): ${flat.toFixed(2)}%\n` +
            `OB: ${obView ? obView.score.toFixed(3) : "n/a"} | Spread: ${obView ? obView.spreadPct.toFixed(2) : "n/a"}% | LOR: ${obView ? obView.lor.toFixed(2) : "n/a"}\n` +
            `Depth(min): ${Math.round(depthUsd).toLocaleString()} | Floor: ${Math.round(floorUsd).toLocaleString()} | DepthOk: ${depthOk}\n` +
            `Gate: ${stage === "ELITE" ? eliteGate.why : stage === "ALMOST" ? almostGate.why : "BUILDUP ok"}`;

          await sendDiscord(hook, fmtMoonLine(c, mode, stage, extra));
        }
      }

      // store state
      state[sym] = {
        stage,
        stageScans,
        enteredAt,
        priceHist,
        volHist,
        sideHist,
        depthOk,
      };

      // elite log when enters ELITE
      if (stageChanged && stage === "ELITE") {
        await bestEffortEliteLog({
          ts: now,
          mode,
          symbol: sym,
          price: c.price,
          change24: c.change24,
          range24: c.range24,
          volume: c.volume,
          marketCap: c.marketCap,
          vm: c.vm,
          confidence: conf,
          consistency: cons,
          volAcc,
          ob: obView,
          obSlope,
          depthUsd,
          floorUsd,
          depthOk,
        });
      }

      // UI item
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
        stageScans,

        confidence: conf,
        consistency: cons,
        volAcc,

        ob: obView ? {
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
        } : { status: "none" },

        obSlope,
        depthUsd,
        floorUsd,
        depthOk,

        why: {
          almost: almostGate.why,
          elite: eliteGate.why,
        }
      };

      if (stage === "ELITE") elite.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else buildup.push(item);
    }

    // sorting
    const sortKey = (a, b) => (b.confidence - a.confidence) || (b.vm - a.vm);
    elite.sort(sortKey);
    almost.sort(sortKey);
    buildup.sort((a, b) => b.vm - a.vm);

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      counts: {
        elite: elite.length,
        almost: almost.length,
        buildup: Math.min(buildup.length, MOON.RADAR_LIMIT),
      },
      funnel: {
        elite,
        almost,
        buildup: buildup.slice(0, MOON.RADAR_LIMIT),
      },
    };

    await kv.set(keyMoonLatest(mode), result);
    await kv.set(keyMoonState(mode), state);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}
