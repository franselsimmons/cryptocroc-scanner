// /api/scan.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "./_core_bull.js"; // alleen voor export config (zelfde in bull/bear)
import { uid, pushEvent, readTrades, writeTrades } from "./_analytics.js";

export const config = RUNTIME_CONFIG;

function coinSideFromMode(mode, change24) {
  if (mode === "bull") return change24 >= 0 ? "BULL" : "BEAR";
  return change24 <= 0 ? "BEAR" : "BULL";
}

function inc(map, k) {
  const key = String(k || "unknown");
  map[key] = (map[key] || 0) + 1;
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    // ✅ eerst core laden, dan pas requireSecret gebruiken
    const core = await import(`./_core_${mode}.js`);

    const {
      SETTINGS,

      requireSecret,

      keyLatest,
      keyState,
      keyReset,
      keyObResult,
      keyObSamples,
      keyEntryLog,
      keyDiagList,
      keyDiagSnap,

      fetchCoinGeckoTopCached,
      fetchBTCGateCached,
      getBitgetSpotUsdtSymbols,
      fetchBitgetAtr1hPctCached,

      applySpikeGuard,

      updateSideHistory,
      calcConsistency,
      updatePriceHist,
      calcChange1hPct,
      calcObSlope,

      nextDesiredStage,
      stageRank,

      webhookForStage,
      sendDiscord,
      fmtCoinLine,

      computeConfidence,
      computeAtrPctFromPriceHist,
      computeSLTP,

      passEntryFromObPlus,
      allocPctRecommended,
      passRadar,
      passBuildup,
      passAlmost,
    } = core;

    if (!requireSecret(req, res)) return;

    // helpers die core keys nodig hebben -> binnen handler
    async function saveDiag(diag) {
      try {
        if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
          await kv.lpush(keyDiagList(mode), JSON.stringify(diag));
          await kv.ltrim(keyDiagList(mode), 0, 200);
        } else {
          await kv.set(keyDiagSnap(mode), diag, { ex: 60 * 60 * 24 * 7 });
        }
      } catch {}
    }

    async function bestEffortLogEntry(entryObj) {
      try {
        if (typeof kv.lpush === "function") {
          await kv.lpush(keyEntryLog, JSON.stringify(entryObj));
          if (typeof kv.ltrim === "function") await kv.ltrim(keyEntryLog, 0, 500);
        } else {
          const k = `log:entry:${entryObj.ts}:${entryObj.mode}:${entryObj.symbol}`;
          await kv.set(k, entryObj, { ex: 60 * 60 * 24 * 30 });
        }
      } catch {}
    }

    // ----- NIEUWE VERSIE VAN openMainTradeIfNeeded MET EXTRA VELDEN -----
    async function openMainTradeIfNeeded({ c, sltp, conf, obView, sizing, btc, atrPct }) {
      const trades = await readTrades("main");
      const exists = trades.find(
        (t) => String(t.status) === "OPEN" && String(t.symbol) === String(c.symbol) && String(t.mode) === String(mode)
      );
      if (exists) return;

      // tel open trades (exclusief de nieuwe)
      const openTradesCountAtEntry = trades.filter(t => t.status === "OPEN").length;

      const t = {
        id: uid("main"),
        funnel: "main",
        status: "OPEN",
        mode,
        symbol: c.symbol,
        cgId: c.id,
        entryAt: Date.now(),
        entryPrice: c.price,
        sl: sltp.sl,
        tp: sltp.tp,

        // context
        stageAtEntry: "ENTRY",
        btcStateAtEntry: String(btc?.state || "NEUTRAL"),
        btcChg24AtEntry: Number(btc?.chg24 || 0),
        btcRange24AtEntry: Number(btc?.range24 || 0),
        atrPctAtEntry: Number(atrPct || 0),

        // portfolio overlap
        openTradesCountAtEntry,

        // fees (schatting)
        feeModel: "estimate",
        feePctPerSide: 0.10,
        feesPaidPctAssumed: 0.20, // 2 * feePctPerSide

        // giveback trail
        givebackTrailEnabled: true,
        givebackTrailTriggerPct: 6,
        trailingActive: false,
        trailingStop: null,

        lastPrice: c.price,
        pnlPct: 0,
        mfePct: 0,
        maePct: 0,
        maxGivebackPct: 0,

        snap: {
          vm: c.vm,
          confidence: conf,
          spreadPct: obView?.spreadPct ?? 0,
          depthMinUsd1p: obView?.depthMinUsd1p ?? 0,
        },

        postBestPct: null,
        postWorstPct: null,

        sizing,
      };

      trades.push(t);
      await writeTrades("main", trades);

      await pushEvent("main", {
        ts: Date.now(),
        funnel: "main",
        mode,
        symbol: c.symbol,
        type: "TRADE_OPEN",
        entryPrice: c.price,
        sl: sltp.sl,
        tp: sltp.tp,
        confidence: conf,
        vm: c.vm,
        btcState: t.btcStateAtEntry,
        atrPct: t.atrPctAtEntry,
      });
    }

    const now = Date.now();
    const btc = await fetchBTCGateCached();

    // bear blokkeren als BTC bull is (zoals jij wil)
    const btcBlocked = mode === "bear" && btc.state === "BULL";

    const symbolsSet = await getBitgetSpotUsdtSymbols();
    const all = await fetchCoinGeckoTopCached();
    const rawCoins = all.filter((c) => symbolsSet.has(c.symbol));

    const resetAt = (await kv.get(keyReset(mode))) || 0;
    const state = (await kv.get(keyState(mode))) || {};

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];

    const diag = {
      ts: now,
      mode,
      btc,
      btcBlocked,
      settings: {
        entry: {
          samplesWindowSec: SETTINGS.entry.samplesWindowSec,
          samplesNeed: SETTINGS.entry.samplesNeed,
          minAgree: SETTINGS.entry.minAgree,
          minDepthBull: SETTINGS.entry.minDepthUsd1pBull,
          minDepthBear: SETTINGS.entry.minDepthUsd1pBear,
          minConfidence: SETTINGS.entry.minConfidence,
          entryConsistencyMin: SETTINGS.entry.entryConsistencyMin,
          obScoreMin: SETTINGS.entry.obScoreMin,
        },
        risk: SETTINGS.risk,
      },
      counts: { radar: 0, buildup: 0, almost: 0, entry: 0 },
      reasons: { entryGate: {}, obReason: {} },
    };

    for (const raw of rawCoins) {
      const sym = raw.symbol;

      const prev = state[sym] || {
        stage: "RADAR",
        stageScans: 0,
        enteredAt: now,
        priceHist: [],
        sideHist: [],
        metricsHist: { vol: [], range: [], vm: [], chg: [] },
        volHist: [],
      };

      const wasReset = Number(prev.enteredAt || 0) < resetAt;
      if (wasReset) {
        prev.stage = "RADAR";
        prev.stageScans = 0;
        prev.enteredAt = now;
        prev.priceHist = [];
        prev.sideHist = [];
        prev.metricsHist = { vol: [], range: [], vm: [], chg: [] };
        prev.volHist = [];
      }

      const { patched: c, nextMetrics } = applySpikeGuard(prev.metricsHist, raw);

      if (!passRadar(c, btc.range24)) {
        delete state[sym];
        continue;
      }

      const priceHist = updatePriceHist(prev.priceHist, c.price);
      const change1h = calcChange1hPct(priceHist);

      const volHist = Array.isArray(prev.volHist) ? prev.volHist.slice(-5) : [];
      volHist.push(c.volume);

      const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
      const last3 = volHist.slice(-3);
      const prev3 = volHist.slice(-6, -3);
      const volAcc = prev3.length ? sum(last3) / Math.max(1, sum(prev3)) : 1.0;

      const wantedSide = mode === "bull" ? "BULL" : "BEAR";
      const sideNow = coinSideFromMode(mode, c.change24);
      const sideHist = updateSideHistory(prev.sideHist, sideNow);
      const cons = calcConsistency(sideHist, wantedSide);

      const ob = await kv.get(keyObResult(mode, sym));
      const obView = ob
        ? {
            valid: !!ob.valid,
            stale: !!ob.stale,
            score: Number(ob?.ob?.score ?? ob?.avgScore ?? 0),
            spreadPct: Number(ob?.ob?.spreadPct ?? 999),
            lor: Number(ob?.ob?.lor ?? 1),
            agree: Number(ob?.agree ?? 0),
            depthMinUsd1p: Number(ob?.ob?.depthMinUsd1p ?? 0),
            reason: ob?.reason || "",
          }
        : null;

      if (obView?.reason) inc(diag.reasons.obReason, obView.reason);

      let obSlope = null;
      if (SETTINGS.entry.obSlopeEnabled) {
        const samples = await kv.get(keyObSamples(mode, sym));
        obSlope = calcObSlope(samples);
      }

      const conf = computeConfidence({
        obScore: obView?.score ?? 0,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc,
      });

      const entryGate = passEntryFromObPlus({
        obView,
        mode,
        consistencyRatio: cons.ratio,
        confidence: conf,
        obSlope,
      });
      inc(diag.reasons.entryGate, entryGate.why);
      const strictEntryOk = entryGate.ok;

      let desired = btcBlocked
        ? "RADAR"
        : nextDesiredStage(c, mode, priceHist, cons.ok, btc.range24, strictEntryOk);

      // stage machine
      let stage = prev.stage || "RADAR";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);

      let stageChanged = false;
      const fromStage = stage;

      if (btcBlocked) {
        if (stage === "RADAR") stageScans += 1;
        else {
          stage = "RADAR";
          stageScans = 1;
          enteredAt = now;
          stageChanged = true;
        }
      } else {
        const prevRank = stageRank(stage);
        const desiredRank = stageRank(desired);

        let nextStage = stage;

        if (desiredRank > prevRank) {
          if (stageScans >= SETTINGS.minScansPerStage) {
            if (desiredRank === prevRank + 1) nextStage = desired;
            else nextStage = prevRank === 1 ? "BUILDUP" : prevRank === 2 ? "ALMOST" : "ENTRY";
          }
        } else if (desiredRank < prevRank) {
          nextStage = desired;
        }

        if (nextStage === stage) stageScans += 1;
        else {
          stage = nextStage;
          stageScans = 1;
          enteredAt = now;
          stageChanged = true;
        }
      }

      const atrFromScan = computeAtrPctFromPriceHist(priceHist);
      const atrObj = await fetchBitgetAtr1hPctCached(sym);
      const atrPct = atrObj?.atrPct && Number.isFinite(atrObj.atrPct) ? atrObj.atrPct : atrFromScan;

      // ✅ BELANGRIJK: confidence meegeven, anders is het altijd “50”
      const sltp = computeSLTP({ mode, price: c.price, atrPct, confidence: conf });

      const sizing = allocPctRecommended({ stage, confidence: conf, btc });

      if (!btcBlocked && stageChanged) {
        let hook = webhookForStage(stage);
        if (hook) {
          const msg = fmtCoinLine(
            c,
            mode,
            stage,
            `Confidence: ${conf}/100 • EntryGate: ${entryGate.why}\nSL: $${sltp.sl.toFixed(6)} | TP: $${sltp.tp.toFixed(6)}`,
            now
          );
          await sendDiscord(hook, msg);
        }
      }

      state[sym] = {
        stage,
        stageScans,
        enteredAt,
        priceHist,
        sideHist,
        metricsHist: nextMetrics,
        volHist,
      };

      if (!btcBlocked && stageChanged && stage === "ENTRY") {
        // AANGEPASTE AANROEP: btc en atrPct toegevoegd
        await openMainTradeIfNeeded({ c, sltp, conf, obView, sizing, btc, atrPct });
        await bestEffortLogEntry({
          ts: now,
          symbol: sym,
          cgId: c.id,
          mode,
          price: c.price,
          change24: c.change24,
          change1h,
          range24: c.range24,
          volume: c.volume,
          marketCap: c.marketCap,
          vm: c.vm,
          obScore: obView?.score ?? null,
          obAgree: obView?.agree ?? null,
          depthMinUsd1p: obView?.depthMinUsd1p ?? null,
          consistency: cons,
          volAcc,
          btc,
          confidence: conf,
          sizing,
          sl: sltp.sl,
          tp: sltp.tp,
          atrPct,
          atrSource: atrObj?.source || "scan",
        });
      }

      const item = {
        id: c.id,
        symbol: sym,
        name: c.name,
        price: c.price,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: c.change24,
        change1h,
        range24: c.range24,
        vm: c.vm,
        stage,
        stageScans,
        confidence: conf,
        atrPct,
        sl: sltp.sl,
        tp: sltp.tp,
        why: { desired, entryGate: entryGate.why },
      };

      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    entry.sort((a, b) => b.confidence - a.confidence);
    almost.sort((a, b) => b.confidence - a.confidence);
    buildup.sort((a, b) => b.confidence - a.confidence);
    radar.sort((a, b) => b.vm - a.vm);

    const radarLimited = radar.slice(0, SETTINGS.RADAR_LIMIT);

    diag.counts = {
      entry: entry.length,
      almost: almost.length,
      buildup: buildup.length,
      radar: radarLimited.length,
    };

    const result = {
      ok: true,
      ts: now,
      epoch: Math.floor(now / 1000),
      mode,
      btc,
      counts: diag.counts,
      funnel: { entry, almost, buildup, radar: radarLimited },
      note: btcBlocked ? `BTC gate BLOCKED: ${btc.state} (mode ${mode}) -> RADAR only` : undefined,
    };

    await kv.set(keyLatest(mode), result);
    await kv.set(keyState(mode), state);
    await saveDiag(diag);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}