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
  keyEntryLog,
  fetchCoinGeckoTop,
  fetchBTCGate,
  getBitgetSpotUsdtSymbols,
  applySpikeGuard,
  updateSideHistory,
  calcConsistency,
  nextDesiredStage,
  stageRank,
  webhookForStage,
  sendDiscord,
  fmtCoinLine,
  passEntryFromOb,
  computeConfidence,
  computeAtrPctFromPriceHist,
  computeSLTP
} from "./_core.js";

export const config = RUNTIME_CONFIG;

function coinSideFromMode(mode, change24) {
  if (mode === "bull") return change24 >= 0 ? "BULL" : "BEAR";
  return change24 <= 0 ? "BEAR" : "BULL";
}

function calcVolAcc(priceHist) {
  // volume acceleration gebruiken we via state.volHist (in scan)
  // hier placeholder: scan vult echte volAcc
  return 1.0;
}

async function bestEffortLogEntry(entryObj) {
  try {
    // @vercel/kv ondersteunt vaak lpush, maar als niet: we fail-silently.
    if (typeof kv.lpush === "function") {
      await kv.lpush(keyEntryLog, JSON.stringify(entryObj));
      if (typeof kv.ltrim === "function") await kv.ltrim(keyEntryLog, 0, 500);
    } else {
      // fallback: unique key
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

    // BTC gate
    const btc = await fetchBTCGate();
    const wanted = mode === "bull" ? "BULL" : "BEAR";

    // Universe (Bitget-first)
    const symbolsSet = await getBitgetSpotUsdtSymbols();
    const all = await fetchCoinGeckoTop();
    const rawCoins = all.filter((c) => symbolsSet.has(c.symbol));

    // KV state
    const resetAt = (await kv.get(keyReset(mode))) || 0;
    const state = (await kv.get(keyState(mode))) || {}; 
    // state[sym] = { stage, stageScans, enteredAt, priceHist, sideHist, metricsHist, volHist }

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

    // Scan coins
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

      // --- spike guard on CG data
      const { patched: c, nextMetrics } = applySpikeGuard(prev.metricsHist, raw);

      // --- update price history (max 6 = ~1 uur)
      const priceHist = Array.isArray(prev.priceHist) ? prev.priceHist.slice(-5) : [];
      priceHist.push(c.price);

      // --- volume history for accel (6 scans = 1 uur)
      const volHist = Array.isArray(prev.volHist) ? prev.volHist.slice(-5) : [];
      volHist.push(c.volume);

      const last3 = volHist.slice(-3);
      const prev3 = volHist.slice(-6, -3);
      const sum = (a) => a.reduce((x, y) => x + (Number(y) || 0), 0);
      const volAcc = prev3.length ? (sum(last3) / Math.max(1, sum(prev3))) : 1.0;

      // --- consistency window (2 uur)
      const wantedSide = mode === "bull" ? "BULL" : "BEAR";
      const sideNow = coinSideFromMode(mode, c.change24);
      const sideHist = updateSideHistory(prev.sideHist, sideNow);
      const cons = calcConsistency(sideHist, wantedSide);

      // --- OB gate (ENTRY)
      const ob = await kv.get(keyObResult(mode, sym));
      const obView = ob ? {
        valid: !!ob.valid,
        stale: !!ob.stale,
        score: Number(ob?.ob?.score ?? ob?.avgScore ?? 0),
        spreadPct: Number(ob?.ob?.spreadPct ?? 999),
        lor: Number(ob?.ob?.lor ?? 1),
        agree: Number(ob?.agree ?? 0),
        reason: ob?.reason || ""
      } : null;

      const obGate = passEntryFromOb(obView ? { ...obView, score: obView.score } : null, mode);
      const obGateOk = obGate.ok;

      // --- desired stage
      const desired = nextDesiredStage(c, mode, priceHist, cons.ok, btc.range24, obGateOk);

      // out?
      if (desired === "OUT") {
        delete state[sym];
        continue;
      }

      // no skip + stage scans
      let stage = prev.stage || "RADAR";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);

      const prevRank = stageRank(stage);
      const desiredRank = stageRank(desired);

      let nextStage = stage;

      if (desiredRank > prevRank) {
        if (stageScans >= SETTINGS.minScansPerStage) {
          // slechts 1 stap omhoog
          if (desiredRank === prevRank + 1) nextStage = desired;
          else nextStage = prevRank === 1 ? "BUILDUP" : prevRank === 2 ? "ALMOST" : "ENTRY";
        }
      } else if (desiredRank < prevRank) {
        nextStage = desired; // omlaag direct
      }

      // update scans
      let stageChanged = false;
      if (nextStage === stage) {
        stageScans += 1;
      } else {
        stage = nextStage;
        stageScans = 1;
        enteredAt = now;
        stageChanged = true;

        // Discord on new stage
        const hook = webhookForStage(stage);
        if (hook) {
          const extra = stage === "ENTRY" && obView
            ? `OB: score=${obView.score.toFixed(3)} spread=${obView.spreadPct.toFixed(2)}% conf=${"?"}`
            : "";
          const msg = fmtCoinLine(c, mode, stage, extra);
          await sendDiscord(hook, msg);
        }
      }

      // compute confidence + SL/TP for UI (alleen echt meaningful in ALMOST/ENTRY)
      const atrPct = computeAtrPctFromPriceHist(priceHist);
      const sltp = computeSLTP({ mode, price: c.price, atrPct });

      const conf = computeConfidence({
        mode,
        obScore: obView?.score ?? 0,
        obAgree: obView?.agree ?? 0,
        vm: c.vm,
        volAcc,
        btc
      });

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

      // log entry only when coin ENTERS entry
      if (stageChanged && stage === "ENTRY") {
        await bestEffortLogEntry({
          ts: now,
          symbol: sym,
          mode,
          price: c.price,
          change24: c.change24,
          range24: c.range24,
          volume: c.volume,
          marketCap: c.marketCap,
          vm: c.vm,
          obScore: obView?.score ?? null,
          spreadPct: obView?.spreadPct ?? null,
          lor: obView?.lor ?? null,
          consistency: cons,
          volAcc,
          btc,
          confidence: conf
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
          reason: obView.reason
        } : { status: "none" },

        confidence: conf,
        atrPct,
        sl: sltp.sl,
        tp: sltp.tp,

        why: {
          desired,
          obGate: obGate.why,
          missing: buildMissingText(mode, c, cons, btc, obGateOk, obView)
        }
      };

      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    // sort (sterkte)
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

function buildMissingText(mode, c, cons, btc, obGateOk, obView) {
  const missing = [];

  if (!cons.ok) missing.push(`Consistency < ${(0.67*100).toFixed(0)}% (min 6 samples/2u)`);
  if (mode === "bull" && c.change24 < SETTINGS.buildup.chgMin) missing.push(`chg24 < ${SETTINGS.buildup.chgMin}%`);
  if (mode === "bear" && c.change24 > -SETTINGS.buildup.chgMin) missing.push(`chg24 > -${SETTINGS.buildup.chgMin}%`);
  if (c.vm < SETTINGS.buildup.vmMin) missing.push(`vm < ${SETTINGS.buildup.vmMin}`);
  if (c.volume < SETTINGS.buildup.volMin) missing.push(`vol < ${SETTINGS.buildup.volMin}`);

  if (c.vm < SETTINGS.almost.vmMin) missing.push(`(ALMOST) vm < ${SETTINGS.almost.vmMin}`);
  if (c.volume < SETTINGS.almost.volMin) missing.push(`(ALMOST) vol < ${SETTINGS.almost.volMin}`);

  if (!obGateOk) {
    if (!obView) missing.push(`OB: geen data (wacht ob-sampler)`);
    else missing.push(`OB: ${obView.reason || "validating / not passed"}`);
  }

  if (btc?.state !== (mode === "bull" ? "BULL" : "BEAR")) missing.push(`BTC gate mismatch`);

  return missing.slice(0, 6);
}