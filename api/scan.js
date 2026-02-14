// /api/scan.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  SETTINGS,
  CFG,
  requireSecret,
  keyLatest,
  keyState,
  keyReset,
  fetchCoinGeckoTop,
  fetchBTCGate,
  getBitgetSpotUsdtSymbols,
  passRadar,
  passBuildup,
  passAlmost,
  stageRank,
  webhookForStage,
  sendDiscord,
  fmtCoinLine,
  computeRisk,
  coinRangeCapFromBtcRange,
  guardWithMedian,
  updateConsistency,
  clamp,
} from "./_core.js";

export const config = RUNTIME_CONFIG;

function stageLabel(stage) {
  return stage === "ELITE" ? "ENTRY" : stage;
}

async function getObResult(side, symbol) {
  const keyRes = `ob:result:${side}:${symbol}`;
  const r = await kv.get(keyRes);
  if (!r) return { ok: true, status: "missing" };

  const ageSec = r?.ob?.ts ? (Date.now() - r.ob.ts) / 1000 : 999;
  const stale = ageSec > CFG.obStaleSec;

  return {
    ok: true,
    status: "present",
    valid: !!r.valid,
    reason: r.reason || null,
    avgScore: r.avgScore ?? null,
    spreadPct: r?.ob?.spreadPct ?? null,
    lor: r?.ob?.lor ?? null,
    score: r?.ob?.score ?? null,
    bidUsd: r?.ob?.bidUsd ?? null,
    askUsd: r?.ob?.askUsd ?? null,
    stale,
  };
}

function coinStrengthScore(c, consistency, ob) {
  // simpele score 0..100 (transparant)
  let s = 0;
  // vm
  s += clamp((c.vm - 0.10) * 120, 0, 35); // 0.10->0, 0.39->35
  // volume
  s += clamp((c.volume / 1_000_000) * 0.8, 0, 20); // 25M ~20
  // change24 richting
  s += clamp(Math.abs(c.change24) * 1.2, 0, 15);
  // consistency
  if (consistency?.total >= SETTINGS.elite.minConsistencySamples) {
    s += clamp(consistency.ratio * 20, 0, 20);
  }
  // orderbook
  if (ob?.status === "present" && !ob.stale) {
    if (ob.valid) s += 10;
    if (Number(ob.avgScore || 0) >= SETTINGS.elite.obMinScore) s += 5;
  }
  return Math.round(clamp(s, 0, 100));
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = (req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    const wanted = mode === "bull" ? "BULL" : "BEAR";

    // BTC gate
    const btc = await fetchBTCGate();
    const coinRangeCap = coinRangeCapFromBtcRange(btc.range24);

    // Universe
    const symbolsSet = await getBitgetSpotUsdtSymbols();
    const all = await fetchCoinGeckoTop();
    const coinsRaw = all.filter((c) => symbolsSet.has(c.symbol));

    // State + resetAt
    const resetAt = (await kv.get(keyReset(mode))) || 0;
    const state = (await kv.get(keyState(mode))) || {};
    const now = Date.now();

    // BTC gate fail => save empty
    if (btc.state !== wanted) {
      const empty = {
        ok: true,
        ts: now,
        epoch: Math.floor(now / 1000),
        mode,
        meta: {
          wanted,
          coinRangeCap,
          consistencyWindow: "2h",
          consistencyMinSamples: SETTINGS.elite.minConsistencySamples,
        },
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

    // --------- main loop ----------
    for (const c0 of coinsRaw) {
      const sym = c0.symbol;

      const prev =
        state[sym] || {
          stage: "RADAR",
          stageScans: 0,
          enteredAt: now,
          priceHist: [],
          // spike hist
          vHist: [],
          rHist: [],
          vmHist: [],
          // consistency hist
          dirHist: [],
        };

      // reset check
      const prevEntered = Number(prev.enteredAt || 0);
      const wasReset = prevEntered < resetAt;

      // spike-guard histories (last 2 kept)
      const vHist = Array.isArray(prev.vHist) ? prev.vHist.slice(-2) : [];
      const rHist = Array.isArray(prev.rHist) ? prev.rHist.slice(-2) : [];
      const vmHist = Array.isArray(prev.vmHist) ? prev.vmHist.slice(-2) : [];

      const safeVolume = guardWithMedian(vHist, c0.volume, 1.0);
      const safeRange24 = guardWithMedian(rHist, c0.range24, 1.0);
      const safeVm = guardWithMedian(vmHist, c0.vm, 1.0);

      // “change24” alleen light guard (heel mild)
      const safeChange24 = clamp(Number(c0.change24 || 0), -50, 50);

      const c = {
        ...c0,
        volume: safeVolume,
        range24: safeRange24,
        vm: safeVm,
        change24: safeChange24,
      };

      // update hists for next time
      vHist.push(safeVolume);
      rHist.push(safeRange24);
      vmHist.push(safeVm);

      // price hist (for flatness)
      const priceHist = Array.isArray(prev.priceHist) ? prev.priceHist.slice(-6) : [];
      priceHist.push(c.price);

      // HARD RESET per coin
      let stage = prev.stage || "RADAR";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);
      let dirHist = Array.isArray(prev.dirHist) ? prev.dirHist : [];

      if (wasReset) {
        stage = "RADAR";
        stageScans = 0;
        enteredAt = now;
        dirHist = []; // heel belangrijk: consistency reset echt naar 0
      }

      // pass radar?
      const okRadar = passRadar(c, coinRangeCap);
      if (!okRadar) {
        delete state[sym];
        continue;
      }

      // consistency update (richting = bull of bear)
      const dir = mode === "bull" ? (c.change24 >= 0 ? "up" : "down") : (c.change24 <= 0 ? "down" : "up");
      const cons = updateConsistency(dirHist, dir, now);
      dirHist = cons.hist;

      // stage desire (tot ALMOST)
      const okBuildup = passBuildup(c, mode);
      const okAlmost = passAlmost(c, mode, priceHist);

      // orderbook info (alleen lezen; geen extra calls)
      const ob = await getObResult(mode, sym);

      // ELITE/ENTRY gate
      const eliteReady =
        okAlmost &&
        cons.pass &&
        ob.status === "present" &&
        ob.valid === true &&
        ob.stale === false &&
        Number(ob.avgScore || 0) >= SETTINGS.elite.obMinScore &&
        Number(ob.spreadPct || 999) <= SETTINGS.elite.obMaxSpreadPct;

      // desired stage
      let desired = "RADAR";
      if (okAlmost) desired = "ALMOST";
      else if (okBuildup) desired = "BUILDUP";
      else desired = "RADAR";
      if (eliteReady) desired = "ELITE";

      // ==== GEEN OVERSLAAN LOGICA ====
      const prevRank = stageRank(stage);
      const desiredRank = stageRank(desired);

      let nextStage = stage;

      if (desiredRank > prevRank) {
        if (stageScans >= SETTINGS.minScansPerStage) {
          if (desiredRank === prevRank + 1) nextStage = desired;
          else {
            // nooit overslaan
            if (prevRank === 1) nextStage = "BUILDUP";
            else if (prevRank === 2) nextStage = "ALMOST";
            else if (prevRank === 3) nextStage = "ELITE";
          }
        }
      } else if (desiredRank < prevRank) {
        nextStage = desired;
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
      }

      // risk calc
      const risk = computeRisk(c, mode);

      // reasons for popup
      const why = {
        btcGate: { wanted, got: btc.state, pass: btc.state === wanted, btcChg24: btc.chg24, btcRange24: btc.range24 },
        coinRangeCap,
        radar: {
          pass: okRadar,
          rules: {
            mcapMin: SETTINGS.mcapMin,
            mcapMax: SETTINGS.mcapMax,
            volMin: SETTINGS.volMinRadar,
            vmMin: SETTINGS.vmMinRadar,
            maxAbsChg24: SETTINGS.maxAbsChg24,
            maxRange24: coinRangeCap,
          },
        },
        buildup: {
          pass: okBuildup,
          rules: SETTINGS.buildup,
        },
        almost: {
          pass: okAlmost,
          rules: SETTINGS.almost,
          priceFlatPctMax: SETTINGS.almost.priceFlatMax,
        },
        consistency: {
          pass: cons.pass,
          window: "2h",
          minSamples: SETTINGS.elite.minConsistencySamples,
          ratioNeed: SETTINGS.elite.minConsistencyRatio,
          total: cons.total,
          same: cons.same,
          ratio: cons.ratio,
          dir,
        },
        orderbook: {
          need: {
            valid: true,
            minScore: SETTINGS.elite.obMinScore,
            maxSpreadPct: SETTINGS.elite.obMaxSpreadPct,
            notStale: true,
          },
          got: ob,
          pass:
            ob.status === "present" &&
            ob.valid === true &&
            ob.stale === false &&
            Number(ob.avgScore || 0) >= SETTINGS.elite.obMinScore &&
            Number(ob.spreadPct || 999) <= SETTINGS.elite.obMaxSpreadPct,
        },
        eliteReady,
        desired,
      };

      const strength = coinStrengthScore(c, cons, ob);

      // Discord alleen bij stage change
      if (stageChanged) {
        const hook = webhookForStage(stage);
        if (hook) {
          const msg = fmtCoinLine(c, mode, stage, { consistency: why.consistency, ob: ob, risk });
          await sendDiscord(hook, msg);
        }
      }

      // save coin state
      state[sym] = {
        stage,
        stageScans,
        enteredAt,
        priceHist,
        vHist,
        rHist,
        vmHist,
        dirHist,
      };

      // item for UI
      const item = {
        symbol: c.symbol,
        name: c.name,
        price: c.price,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: c.change24,
        range24: c.range24,
        vm: c.vm,
        stage,
        stageLabel: stageLabel(stage),
        stageScans,
        strength,
        risk,
        why,
      };

      if (stage === "RADAR") radar.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "ELITE") entry.push(item);
    }

    // sort
    const byStrength = (a, b) => b.strength - a.strength;
    entry.sort(byStrength);
    almost.sort(byStrength);
    buildup.sort(byStrength);
    radar.sort((a, b) => b.vm - a.vm);

    const radarLimited = radar.slice(0, SETTINGS.RADAR_LIMIT);

    const result = {
      ok: true,
      ts: now,
      epoch: Math.floor(now / 1000),
      mode,
      meta: {
        wanted,
        coinRangeCap,
        consistencyWindow: "2h",
        consistencyMinSamples: SETTINGS.elite.minConsistencySamples,
        obStaleSec: CFG.obStaleSec,
      },
      btc,
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radarLimited.length,
      },
      funnel: {
        entry,
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