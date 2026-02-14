// /api/scan.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  SETTINGS,
  requireSecret,
  keyLatest,
  keyState,
  keyReset,
  fetchCoinGeckoTop,
  fetchBTCGate,
  getBitgetSpotUsdtSymbols,
  nextDesiredStage,
  stageRank,
  webhookForStage,
  sendDiscord,
  fmtCoinLine,
  guardSpike,
  guardChange24,
  pruneWindow,
  computeConsistency,
  explainStage,
  strengthScore,
} from "./_core.js";

export const config = RUNTIME_CONFIG;

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
    const btc = await fetchBTCGate();
    const wanted = mode === "bull" ? "BULL" : "BEAR";

    // Universe (Bitget-first)
    const symbolsSet = await getBitgetSpotUsdtSymbols();
    const allRaw = await fetchCoinGeckoTop();
    const coinsRaw = allRaw.filter((c) => symbolsSet.has(c.symbol));

    // State + resetAt
    const resetAt = (await kv.get(keyReset(mode))) || 0;
    const state = (await kv.get(keyState(mode))) || {};
    // state[sym] = { stage, stageScans, enteredAt, priceHist[], metricsHist{vol[],range[],vm[],chg[]}, dirHist[] }

    // Als BTC niet in juiste state -> output leeg + bewaren
    if (btc.state !== wanted) {
      const empty = {
        ok: true,
        ts: now,
        epoch: Math.floor(now / 1000),
        mode,
        btc,
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
        funnel: { radar: [], buildup: [], almost: [], entry: [] },
        note: `BTC gate: ${btc.state} (needed ${wanted})`,
      };
      await kv.set(keyLatest(mode), empty);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(empty));
    }

    const radar = [];
    const buildup = [];
    const almost = [];

    for (const raw of coinsRaw) {
      const sym = raw.symbol;
      const prev = state[sym] || {
        stage: "RADAR",
        stageScans: 0,
        enteredAt: now,
        priceHist: [],
        metricsHist: { vol: [], range: [], vm: [], chg: [] },
        dirHist: [],
      };

      // reset detect
      const prevEntered = Number(prev.enteredAt || 0);
      const wasReset = prevEntered < resetAt;

      // ---- metrics histories (voor spike-guard) ----
      const mh = prev.metricsHist || { vol: [], range: [], vm: [], chg: [] };
      const volHist = Array.isArray(mh.vol) ? mh.vol.slice(-3) : [];
      const rngHist = Array.isArray(mh.range) ? mh.range.slice(-3) : [];
      const vmHist  = Array.isArray(mh.vm) ? mh.vm.slice(-3) : [];
      const chgHist = Array.isArray(mh.chg) ? mh.chg.slice(-3) : [];

      // apply guards
      const guarded = { ...raw };
      guarded.volume = guardSpike(raw.volume, volHist);
      guarded.range24 = guardSpike(raw.range24, rngHist);
      guarded.vm = guardSpike(raw.vm, vmHist);
      guarded.change24 = guardChange24(raw.change24, chgHist);

      // update metric hist (met guarded values)
      volHist.push(guarded.volume);
      rngHist.push(guarded.range24);
      vmHist.push(guarded.vm);
      chgHist.push(guarded.change24);

      // price hist (flatness)
      const priceHist = Array.isArray(prev.priceHist) ? prev.priceHist.slice(-6) : [];
      priceHist.push(guarded.price);

      // consistency window hist
      let dirHist = pruneWindow(prev.dirHist, now, SETTINGS.consistencyWindowMin);
      // ok = “richting klopt”
      const passSide =
        mode === "bull" ? guarded.change24 >= 0 : guarded.change24 <= 0;
      dirHist.push({ ts: now, ok: passSide });

      const cons = computeConsistency(
        dirHist,
        now,
        SETTINGS.consistencyWindowMin,
        SETTINGS.consistencyMinSamples
      );

      // reset -> echt vanaf 0: force RADAR + nieuwe hist
      let stage = prev.stage || "RADAR";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);

      if (wasReset) {
        stage = "RADAR";
        stageScans = 0;
        enteredAt = now;
        // ook consistency opnieuw beginnen (anders “oude trend” blijft hangen)
        dirHist = [];
      }

      // desired stage (zonder overslaan)
      const desired = nextDesiredStage(guarded, mode, priceHist, btc);

      if (desired === "OUT") {
        delete state[sym];
        continue;
      }

      // extra: consistency gate (alleen voor BUILDUP/ALMOST)
      const consRatio = cons.ratio; // null als te weinig samples
      const consOk =
        consRatio == null ? false : consRatio >= SETTINGS.consistencyMinRatio;

      let desired2 = desired;
      if ((desired2 === "BUILDUP" || desired2 === "ALMOST") && !consOk) {
        // te weinig/te zwak -> blijft RADAR (instroom blijft breed, maar doorstroom netjes)
        desired2 = "RADAR";
      }

      const prevRank = stageRank(stage);
      const desiredRank = stageRank(desired2);

      let nextStage = stage;

      if (desiredRank > prevRank) {
        if (stageScans >= SETTINGS.minScansPerStage) {
          // max 1 stap omhoog
          if (desiredRank === prevRank + 1) nextStage = desired2;
          else nextStage = prevRank === 1 ? "BUILDUP" : "ALMOST";
        }
      } else if (desiredRank < prevRank) {
        nextStage = desired2; // omlaag direct
      }

      // update scans
      if (nextStage === stage) {
        stageScans += 1;
      } else {
        stage = nextStage;
        stageScans = 1;
        enteredAt = now;

        // Discord on new stage
        const hook = webhookForStage(stage);
        if (hook) {
          const strength = strengthScore(guarded, btc, consRatio);
          const msg = fmtCoinLine(guarded, mode, stage, { strength, consistency: consRatio });
          await sendDiscord(hook, msg);
        }
      }

      // explanations for popup
      const expl = explainStage(guarded, mode, priceHist, btc, consRatio);
      const strength = strengthScore(guarded, btc, consRatio);

      // save back
      state[sym] = {
        stage,
        stageScans,
        enteredAt,
        priceHist,
        metricsHist: { vol: volHist, range: rngHist, vm: vmHist, chg: chgHist },
        dirHist,
      };

      // UI item
      const item = {
        symbol: guarded.symbol,
        name: guarded.name,
        price: guarded.price,
        volume: guarded.volume,
        marketCap: guarded.marketCap,
        change24: guarded.change24,
        range24: guarded.range24,
        vm: guarded.vm,
        stage,
        stageScans,
        enteredAt,
        // popup fields
        consistency: consRatio,
        consistencySamples: cons.total,
        strength,
        reasons: expl.reasons,
        missing: expl.missing,
        needBuildup: expl.needBuildup,
        needAlmost: expl.needAlmost,
        btc,
      };

      if (stage === "RADAR") radar.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else if (stage === "ALMOST") almost.push(item);
    }

    // sort + limit
    radar.sort((a, b) => b.vm - a.vm);
    buildup.sort((a, b) => b.vm - a.vm);
    almost.sort((a, b) => b.vm - a.vm);

    const radarLimited = radar.slice(0, SETTINGS.RADAR_LIMIT);

    const result = {
      ok: true,
      ts: now,
      epoch: Math.floor(now / 1000),
      mode,
      btc,
      counts: {
        entry: 0,
        almost: almost.length,
        buildup: buildup.length,
        radar: radarLimited.length,
      },
      funnel: {
        entry: [],
        almost,
        buildup,
        radar: radarLimited,
      },
    };

    await kv.set(keyLatest(mode), result);
    await kv.set(keyState(mode), state);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}