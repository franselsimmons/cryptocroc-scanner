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
  fetchBitgetAtr1hPctCached,     // fase 2
  applySpikeGuard,
  updateSideHistory,
  calcConsistency,
  updatePriceHist,               // fase 1
  calcChange1hPct,               // fase 1
  calcObSlope,                   // fase 1
  nextDesiredStage,
  stageRank,
  webhookForStage,
  sendDiscord,
  fmtCoinLine,
  computeConfidence,
  computeAtrPctFromPriceHist,
  computeSLTP,
  passEntryFromObPlus,           // fase 1 gates
} from "./_core.js";

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

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = (req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    const now = Date.now();

    // BTC gate (cached 10 min)
    const btc = await fetchBTCGateCached();
    const wanted = mode === "bull" ? "BULL" : "BEAR";

    // Universe (Bitget-first)
    const symbolsSet = await getBitgetSpotUsdtSymbols();

    // CoinGecko top (cached 10 min)
    const all = await fetchCoinGeckoTopCached();
    const rawCoins = all.filter((c) => symbolsSet.has(c.symbol));

    // KV state
    const resetAt = (await kv.get(keyReset(mode))) || 0;
    const state = (await kv.get(keyState(mode))) || {};

    // BTC mismatch => output leeg
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
        volHist: []
      };

      // reset per coin (hard)
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

      // spike guard
      const { patched: c, nextMetrics } = applySpikeGuard(prev.metricsHist, raw);

      // price history (timestamped) + 1h change
      const priceHist = updatePriceHist(prev.priceHist, c.price);
      const change1h = calcChange1hPct(priceHist);

      // volume history (6 samples-ish)
      const volHist = Array.isArray(prev.volHist) ? prev.volHist.slice(-5) : [];
      volHist.push(c.volume);

      const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
      const last3 = volHist.slice(-3);
      const prev3 = volHist.slice(-6, -3);
      const volAcc = prev3.length ? (sum(last3) / Math.max(1, sum(prev3))) : 1.0;

      // consistency (2 uur window)
      const wantedSide = mode === "bull" ? "BULL" : "BEAR";
      const sideNow = coinSideFromMode(mode, c.change24);
      const sideHist = updateSideHistory(prev.sideHist, sideNow);
      const cons = calcConsistency(sideHist, wantedSide);

      // OB result (ENTRY gate)
      const ob = await kv.get(keyObResult(mode, sym));
      const obView = ob ? {
        valid: !!ob.valid,
        stale: !!ob.stale,
        score: Number(ob?.ob?.score ?? ob?.avgScore ?? 0),
        spreadPct: Number(ob?.ob?.spreadPct ?? 999),
        lor: Number(ob?.ob?.lor ?? 1),
        agree: Number(ob?.agree ?? 0),
        depthMinUsd1p: Number(ob?.ob?.depthMinUsd1p ?? 0), // ✅ nieuw
        reason: ob?.reason || ""
      } : null;

      // OB samples => slope
      let obSlope = null;
      if (SETTINGS.entry.obSlopeEnabled) {
        const samples = await kv.get(keyObSamples(mode, sym));
        obSlope = calcObSlope(samples);
      }

      // Confidence
      const conf = computeConfidence({
        obScore: obView?.score ?? 0,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc
      });

      // ENTRY OK? (OB + consistency(75%) + confidence>=70 + slope + depth 1%)
      const entryGate = passEntryFromObPlus({
        obView,
        mode,
        consistencyRatio: cons.ratio,
        confidence: conf,
        obSlope
      });
      const entryOk = entryGate.ok;

      // desired stage
      const desired = nextDesiredStage(
        c,
        mode,
        priceHist,
        cons.ok,
        btc.range24,
        entryOk
      );

      // out?
      if (desired === "OUT") {
        delete state[sym];
        continue;
      }

      // stage update (no skip)
      let stage = prev.stage || "RADAR";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);

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

      let stageChanged = false;
      if (nextStage === stage) {
        stageScans += 1;
      } else {
        stage = nextStage;
        stageScans = 1;
        enteredAt = now;
        stageChanged = true;
      }

      // ATR (fase 2: Bitget 1H ATR) + fallback scan-ATR
      const atrFromScan = computeAtrPctFromPriceHist(priceHist);
      const atrObj = await fetchBitgetAtr1hPctCached(sym);
      const atrPct = atrObj?.atrPct && Number.isFinite(atrObj.atrPct) ? atrObj.atrPct : atrFromScan;

      const sltp = computeSLTP({ mode, price: c.price, atrPct });

      // Discord on new stage
      if (stageChanged) {
        const hook = webhookForStage(stage);
        if (hook) {
          let extra = `Confidence: ${conf}/100`;

          if (stage === "ENTRY") {
            const obTxt = obView
              ? `OB: ${obView.score.toFixed(3)} | spread: ${obView.spreadPct.toFixed(2)}% | LOR: ${obView.lor.toFixed(2)} | agree: ${obView.agree}/3 | depth1%: $${Math.round(obView.depthMinUsd1p)}`
              : `OB: (no data)`;

            const slopeTxt = Number.isFinite(obSlope) ? `OB slope: ${obSlope.toFixed(4)}` : `OB slope: n/a`;
            const atrSrc = atrObj?.source ? `ATR src: ${atrObj.source}` : `ATR src: scan`;

            extra =
              `Confidence: ${conf}/100\n` +
              `EntryGate: ${entryGate.why}\n` +
              `${obTxt}\n` +
              `${slopeTxt}\n` +
              `Consistency: ${(cons.ratio * 100).toFixed(0)}% (${cons.same}/${cons.total})\n` +
              `chg1h: ${change1h == null ? "n/a" : (change1h >= 0 ? "+" : "") + change1h.toFixed(2) + "%"}\n` +
              `SL: $${sltp.sl.toFixed(6)} | TP: $${sltp.tp.toFixed(6)} | ATR~: ${(atrPct * 100).toFixed(2)}% (${atrSrc})`;
          }

          const msg = fmtCoinLine(c, mode, stage, extra);
          await sendDiscord(hook, msg);
        }
      }

      // store state
      state[sym] = {
        stage,
        stageScans,
        enteredAt,
        priceHist,
        sideHist,
        metricsHist: nextMetrics,
        volHist
      };

      // log entry when ENTERS ENTRY
      if (stageChanged && stage === "ENTRY") {
        await bestEffortLogEntry({
          ts: now,
          symbol: sym,
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
          depthMinUsd1p: obView?.depthMinUsd1p ?? null, // ✅ nieuw
          consistency: cons,
          volAcc,
          btc,
          confidence: conf,
          sl: sltp.sl,
          tp: sltp.tp,
          atrPct,
          atrSource: atrObj?.source || "scan",
        });
      }

      // UI item
      const item = {
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

        ob: obView ? {
          status: obView.valid ? "valid" : "validating",
          valid: obView.valid,
          stale: obView.stale,
          score: obView.score,
          spreadPct: obView.spreadPct,
          lor: obView.lor,
          agree: obView.agree,
          depthMinUsd1p: obView.depthMinUsd1p, // ✅ nieuw
          reason: obView.reason
        } : { status: "none" },

        obSlope,

        confidence: conf,
        atrPct,
        atrSource: atrObj?.source || "scan",
        sl: sltp.sl,
        tp: sltp.tp,

        why: {
          desired,
          entryGate: entryGate.why,
        }
      };

      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    // sort
    const sortKey = (a, b) => (b.confidence - a.confidence) || (b.vm - a.vm);

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