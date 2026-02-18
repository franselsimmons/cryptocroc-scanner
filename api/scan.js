// /api/scan.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  SETTINGS,
  requireSecret,
  keyLatest,
  keyState,
  keyReset,
  keyObResult,
  keyObSamples,
  keyEntryLog,
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
  passRadar, // ✅ nieuw: nodig voor RADAR-only mode bij BTC-block
} from "./_core.js";

import { uid, pushEvent, readTrades, writeTrades } from "./_analytics.js";

export const config = RUNTIME_CONFIG;

function coinSideFromMode(mode, change24) {
  if (mode === "bull") return change24 >= 0 ? "BULL" : "BEAR";
  return change24 <= 0 ? "BEAR" : "BULL";
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

async function openMainTradeIfNeeded({ mode, c, sltp, conf, obView, sizing }) {
  const trades = await readTrades("main");
  const exists = trades.find(
    (t) =>
      String(t.status) === "OPEN" &&
      String(t.symbol) === String(c.symbol) &&
      String(t.mode) === String(mode)
  );
  if (exists) return;

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

    lastPrice: c.price,
    pnlPct: 0,

    snap: {
      vm: c.vm,
      confidence: conf,
      spreadPct: obView?.spreadPct ?? 0,
      depthMinUsd1p: obView?.depthMinUsd1p ?? 0,
    },

    mfePct: 0,
    maePct: 0,
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
  });
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

    const btc = await fetchBTCGateCached();
    const wanted = mode === "bull" ? "BULL" : "BEAR";

    // ✅ nieuw: als BTC niet klopt -> we vullen RADAR-only
    const btcBlocked = btc.state !== wanted;

    const symbolsSet = await getBitgetSpotUsdtSymbols();
    const all = await fetchCoinGeckoTopCached();
    const rawCoins = all.filter((c) => symbolsSet.has(c.symbol));

    const resetAt = (await kv.get(keyReset(mode))) || 0;
    const state = (await kv.get(keyState(mode))) || {};

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];

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

      // ✅ nieuw: RADAR filter ALTIJD toepassen (ook bij btcBlocked)
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
      const entryOk = entryGate.ok;

      // ✅ nieuw: bij btcBlocked forceren we desired = RADAR
      const desired = btcBlocked
        ? "RADAR"
        : nextDesiredStage(c, mode, priceHist, cons.ok, btc.range24, entryOk);

      let stage = prev.stage || "RADAR";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);

      let stageChanged = false;
      const fromStage = stage;

      if (btcBlocked) {
        // ✅ nieuw: stage mag NIET omhoog bij BTC block
        const nextStage = "RADAR";

        if (nextStage === stage) {
          stageScans += 1;
        } else {
          stage = nextStage;
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

        if (nextStage === stage) {
          stageScans += 1;
        } else {
          stage = nextStage;
          stageScans = 1;
          enteredAt = now;
          stageChanged = true;
        }
      }

      const atrFromScan = computeAtrPctFromPriceHist(priceHist);
      const atrObj = await fetchBitgetAtr1hPctCached(sym);
      const atrPct = atrObj?.atrPct && Number.isFinite(atrObj.atrPct) ? atrObj.atrPct : atrFromScan;

      const sltp = computeSLTP({ mode, price: c.price, atrPct });
      const sizing = allocPctRecommended({ stage, confidence: conf, btc });

      if (stageChanged) {
        await pushEvent("main", {
          ts: now,
          funnel: "main",
          mode,
          symbol: sym,
          type: "STAGE",
          from: fromStage,
          to: stage,
          metrics: {
            vm: c.vm,
            volAcc,
            confidence: conf,
            spreadPct: obView?.spreadPct ?? null,
            depthMinUsd1p: obView?.depthMinUsd1p ?? null,
          },
        });
      }

      // ✅ nieuw: geen Discord spam als BTC geblokkeerd is
      if (!btcBlocked && stageChanged) {
        let hook = webhookForStage(stage);
        if (!hook && stage === "ENTRY") hook = process.env.DISCORD_WEBHOOK_ELITE;

        if (hook) {
          let extra = `Confidence: ${conf}/100 • Advies: ${sizing.pct}% (BTC ${sizing.zone})`;

          if (stage === "ENTRY") {
            const obTxt = obView
              ? `OB: ${obView.score.toFixed(3)} | spread: ${obView.spreadPct.toFixed(
                  2
                )}% | LOR: ${obView.lor.toFixed(2)} | agree: ${obView.agree}/3 | depth1%: $${Math.round(
                  obView.depthMinUsd1p
                )}`
              : `OB: (no data)`;

            const slopeTxt = Number.isFinite(obSlope) ? `OB slope: ${obSlope.toFixed(4)}` : `OB slope: n/a`;
            const atrSrc = atrObj?.source ? `ATR src: ${atrObj.source}` : `ATR src: scan`;

            extra =
              `Confidence: ${conf}/100\n` +
              `Advies inzet: ${sizing.pct}% (BTC ${sizing.zone} cap ${sizing.btcCap}%, stage cap ${sizing.stageCap}%)\n` +
              `EntryGate: ${entryGate.why}\n` +
              `${obTxt}\n` +
              `${slopeTxt}\n` +
              `Consistency: ${(cons.ratio * 100).toFixed(0)}% (${cons.same}/${cons.total})\n` +
              `chg1h: ${
                change1h == null
                  ? "n/a"
                  : (change1h >= 0 ? "+" : "") + change1h.toFixed(2) + "%"
              }\n` +
              `SL: $${sltp.sl.toFixed(6)} | TP: $${sltp.tp.toFixed(6)} | ATR~: ${(atrPct * 100).toFixed(
                2
              )}% (${atrSrc})`;
          }

          const msg = fmtCoinLine(c, mode, stage, extra);
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

      // ✅ nieuw: geen trade open/log als BTC geblokkeerd is
      if (!btcBlocked && stageChanged && stage === "ENTRY") {
        await openMainTradeIfNeeded({ mode, c, sltp, conf, obView, sizing });

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
          spreadPct: obView?.spreadPct ?? null,
          lor: obView?.lor ?? null,
          obAgree: obView?.agree ?? null,
          obSlope,
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
        consistency: cons,
        volAcc,

        sizing,

        ob: obView
          ? {
              status: obView.valid ? "valid" : "validating",
              valid: obView.valid,
              stale: obView.stale,
              score: obView.score,
              spreadPct: obView.spreadPct,
              lor: obView.lor,
              agree: obView.agree,
              depthMinUsd1p: obView.depthMinUsd1p,
              reason: obView.reason,
            }
          : { status: "none" },

        obSlope,

        confidence: conf,
        atrPct,
        atrSource: atrObj?.source || "scan",
        sl: sltp.sl,
        tp: sltp.tp,

        why: {
          desired,
          entryGate: entryGate.why,
        },
      };

      // ✅ bij btcBlocked gaat alles in RADAR
      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    const sortKey = (a, b) => b.confidence - a.confidence || b.vm - a.vm;

    entry.sort(sortKey);
    almost.sort(sortKey);
    buildup.sort(sortKey);
    radar.sort((a, b) => b.vm - a.vm);

    const radarLimited = radar.slice(0, SETTINGS.RADAR_LIMIT);

    const result = {
      ok: true,
      ts: now,
      epoch: Math.floor(now / 1000),
      mode,
      btc,
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radarLimited.length,
      },
      funnel: { entry, almost, buildup, radar: radarLimited },
      note: btcBlocked ? `BTC gate BLOCKED: ${btc.state} (wanted ${wanted}) → RADAR only` : undefined,
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