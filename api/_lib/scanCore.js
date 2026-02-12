import { CFG } from "./config.js";
import { fetchJson, rangePct, vmRatio, ctlProxy, n, sleep } from "./utils.js";
import { loadUsdtSpotMap, fetchOB, calcObMetrics } from "./bitget.js";

// stages
const STAGES = ["RADAR","BUILDUP","ALMOST","ENTRY"];
const stageIndex = (s) => Math.max(0, STAGES.indexOf(s || "RADAR"));

function moveOneStep(cur, des) {
  const ci = stageIndex(cur), di = stageIndex(des);
  if (di > ci) return STAGES[ci + 1] || cur;
  if (di < ci) return STAGES[Math.max(0, ci - 1)] || cur;
  return cur;
}

// bands
function inBand(x, band) {
  if (x == null) return false;
  return x >= band.ch24Min && x <= band.ch24Max;
}
function decideSide(ch24) {
  const bullOk = inBand(ch24, CFG.bands.bull);
  const bearOk = inBand(ch24, CFG.bands.bear);

  if (bullOk && !bearOk) return "BULL";
  if (!bullOk && bearOk) return "BEAR";
  if (bullOk && bearOk) return ch24 >= 0 ? "BULL" : "BEAR"; // overlap fallback
  return null;
}

// stage minima
function passStageMin(c, stage) {
  const t = CFG.stageMin[stage];
  if (!t) return false;
  return c.vol >= t.volMin && c.vm >= t.vmMin;
}

// timing
function timingScore(side, c) {
  let s = 0;
  if (side === "BULL") {
    if (c.ch24 != null && c.ch24 > 0) s++;
    if (c.vm != null && c.vm >= CFG.stageMin.BUILDUP.vmMin) s++;
    if (c.range != null && c.range >= 4.2 && c.range <= 25) s++;
    if (c.ctl != null && c.ctl >= 0.70) s++;
  } else {
    if (c.ch24 != null && c.ch24 < 0) s++;
    if (c.vm != null && c.vm >= CFG.stageMin.BUILDUP.vmMin) s++;
    if (c.range != null && c.range >= 4.2 && c.range <= 25) s++;
    if (c.ctl != null && c.ctl <= 0.30) s++;
  }
  return s; // 0..4
}

// memory helpers
function initMem(symbol) {
  return { symbol, stage: "RADAR", totalScans: 0, scansInStage: 0, hist: [], lastExplain: "" };
}
function normalizeMem(mem, symbol) {
  if (!mem || typeof mem !== "object") mem = {};
  if (!mem.symbol) mem.symbol = symbol;
  if (!mem.stage) mem.stage = "RADAR";
  if (!Number.isFinite(mem.totalScans)) mem.totalScans = 0;
  if (!Number.isFinite(mem.scansInStage)) mem.scansInStage = 0;
  if (!Array.isArray(mem.hist)) mem.hist = [];
  if (typeof mem.lastExplain !== "string") mem.lastExplain = "";
  return mem;
}
function pushHist(mem, e) {
  mem.hist.push(e);
  if (mem.hist.length > 12) mem.hist.shift();
}
function calcConsistency(mem) {
  const last = mem.hist.slice(-6);
  if (!last.length) return 0;
  return last.filter(x => x.passSide === true).length / last.length;
}
function calcVolAcceleration(mem) {
  const h = mem.hist.slice(-6);
  if (h.length < 6) return 0;
  const a = h.slice(0,3).reduce((s,x)=>s+(x.vol||0),0)/3;
  const b = h.slice(3,6).reduce((s,x)=>s+(x.vol||0),0)/3;
  if (a <= 0) return 0;
  return (b - a) / a;
}
function calcPriceFlat(mem) {
  const prices = mem.hist.slice(-6).map(x=>x.price).filter(v=>Number.isFinite(v));
  if (prices.length < 3) return null;
  const mn = Math.min(...prices);
  const mx = Math.max(...prices);
  if (mn <= 0) return null;
  return ((mx - mn) / mn) * 100;
}

// regime (BTC range 24h)
async function detectRegime() {
  const override = (process.env.REGIME_OVERRIDE || "").toUpperCase().trim();
  if (override === "HIGH_VOL" || override === "GRIND") {
    return { regime: override, btcRange24h: null, source: "override" };
  }

  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1&sparkline=false";

  const data = await fetchJson(url, 4);
  const btc = Array.isArray(data) ? data[0] : null;
  const r = rangePct(btc?.high_24h, btc?.low_24h);
  const btcRange24h = r == null ? 0 : r;
  const regime = (btcRange24h > CFG.regime.btcRangeHighVol) ? "HIGH_VOL" : "GRIND";
  return { regime, btcRange24h, source: "btc_range_24h" };
}

function pickEngine(regime, volAcc, flat) {
  if (regime === "HIGH_VOL") return volAcc >= 0.20 ? "EXPLOSIE" : "ACCUMULATIE";
  return (flat != null && flat <= 3.5) ? "ACCUMULATIE" : "EXPLOSIE";
}

function obPassForEntry(side, engine, obScore) {
  if (obScore == null || !Number.isFinite(obScore)) return false;
  if (engine === "EXPLOSIE") {
    if (side === "BULL") return obScore >= CFG.engines.EXPLOSIE.entryObMinBull;
    return obScore <= CFG.engines.EXPLOSIE.entryObMinBear;
  } else {
    if (side === "BULL") return obScore >= CFG.engines.ACCUMULATIE.entryObMinBull;
    return obScore <= CFG.engines.ACCUMULATIE.entryObMinBear;
  }
}

function expectancyProxy(row) {
  const cons = row.consistency ?? 0;
  const va = row.volAcceleration ?? 0;
  const ob = row.ob?.score ?? 0;
  const score = (cons*1.2) + (Math.max(-0.2, Math.min(0.8, va))*0.9) + (Math.max(-0.2, Math.min(0.2, ob))*1.0);
  return score;
}
function sizingPlan(engine, expScore) {
  if (engine === "EXPLOSIE") {
    if (expScore >= 1.35) return { suggestedSizePct: 100, label: "A" };
    if (expScore >= 1.05) return { suggestedSizePct: 80, label: "B" };
    return { suggestedSizePct: 50, label: "C" };
  } else {
    if (expScore >= 1.25) return { suggestedSizePct: 100, label: "A" };
    if (expScore >= 1.00) return { suggestedSizePct: 90, label: "B" };
    return { suggestedSizePct: 60, label: "C" };
  }
}
function tradePlan(engine) {
  if (engine === "EXPLOSIE") {
    return {
      hardStop: "-1R",
      breakevenAt: "+1R",
      partialTP: "+2R -> 30%",
      edgeExit: "Als volAcc < 0 of OB <= 0: 50% eruit, rest op zwakte."
    };
  }
  return {
    hardStop: "-1R",
    breakevenAt: "+1R",
    partialTP: "+1.5R -> 30%",
    edgeExit: "Als flat > 3% of consistency zakt: 50% eruit, rest op zwakte."
  };
}

async function fetchTopCoins() {
  const out = [];
  const seen = new Set();

  for (let page = 1; page <= CFG.cg.pages; page++) {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets" +
      `?vs_currency=${encodeURIComponent(CFG.cg.vs)}` +
      `&order=${encodeURIComponent(CFG.cg.order)}` +
      `&per_page=${CFG.cg.perPage}` +
      `&page=${page}` +
      `&sparkline=false` +
      `&price_change_percentage=24h`;

    const data = await fetchJson(url, 4);
    if (!Array.isArray(data) || !data.length) break;

    for (const x of data) {
      if (!x?.id || seen.has(x.id)) continue;
      seen.add(x.id);

      const sym = (x.symbol || "").toUpperCase();
      const c = {
        id: x.id,
        symbol: sym,
        name: x.name || sym,
        price: n(x.current_price),
        mcap: n(x.market_cap),
        vol: n(x.total_volume),
        high: n(x.high_24h),
        low: n(x.low_24h),
        ch24: n(x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h)
      };

      c.range = rangePct(c.high, c.low);
      c.vm = vmRatio(c.vol, c.mcap);
      c.ctl = ctlProxy(c.price, c.high, c.low);

      if (!c.symbol || c.price == null || c.mcap == null || c.vol == null || c.vm == null || c.ch24 == null) continue;

      // pool filter
      if (c.mcap < CFG.pool.mcapMin || c.mcap > CFG.pool.mcapMax) continue;
      if (c.vol < CFG.pool.volMin || c.vm < CFG.pool.vmMin) continue;

      out.push(c);
    }

    await sleep(CFG.cg.delayMs);
  }

  return out;
}

export async function runFullScan(redis) {
  const ts = new Date().toISOString();
  const regimeInfo = await detectRegime();
  const coins = await fetchTopCoins();
  const bitgetMap = await loadUsdtSpotMap(redis);

  const bull = { entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };
  const bear = { entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };

  let obCalls = 0;

  for (const c of coins) {
    const side = decideSide(c.ch24);
    if (!side) continue;

    const memKey = `mem:v1:${side}:${c.symbol}`;
    const memRaw = await redis.get(memKey);
    const mem = normalizeMem(memRaw || initMem(c.symbol), c.symbol);

    // passSide = voldoet aan RADAR minima + band
    const passSide = passStageMin(c, "RADAR") && inBand(c.ch24, side === "BULL" ? CFG.bands.bull : CFG.bands.bear);

    mem.totalScans += 1;
    pushHist(mem, { ts, price: c.price, vol: c.vol, vm: c.vm, passSide });

    const cons = calcConsistency(mem);
    const volAcc = calcVolAcceleration(mem);
    const flat = calcPriceFlat(mem);
    const engine = pickEngine(regimeInfo.regime, volAcc, flat);

    // FIX #1: nieuwe coin direct in RADAR output
    if (mem.totalScans === 1) {
      mem.stage = "RADAR";
      mem.scansInStage = 1;
      mem.lastExplain = `Nieuw → RADAR lock (1/${CFG.funnel.minScansToLeaveRadar})`;
      await redis.set(memKey, mem);

      const row = baseRow(c, side, mem, regimeInfo, engine, cons, volAcc, flat);
      row.explain = mem.lastExplain;
      putRow(side, row, bull, bear);
      continue;
    }

    // faalt basis -> demote
    if (!passSide) {
      const curI = stageIndex(mem.stage);
      mem.stage = CFG.funnel.demoteOneStep ? STAGES[Math.max(0, curI - 1)] : "RADAR";
      mem.scansInStage = 1;
      mem.lastExplain = "Faalt RADAR basis (band/vol/vm) → 1 stap terug.";
      await redis.set(memKey, mem);
      continue;
    }

    // RADAR lock
    if (mem.stage === "RADAR" && mem.totalScans < CFG.funnel.minScansToLeaveRadar) {
      mem.scansInStage += 1;
      mem.lastExplain = `RADAR lock: ${mem.totalScans}/${CFG.funnel.minScansToLeaveRadar}`;
      await redis.set(memKey, mem);

      const row = baseRow(c, side, mem, regimeInfo, engine, cons, volAcc, flat);
      row.explain = mem.lastExplain;
      putRow(side, row, bull, bear);
      continue;
    }

    // BUILDUP/ALMOST/ENTRY logica
    const tScore = timingScore(side, c);

    const buildupOk =
      passStageMin(c, "BUILDUP") &&
      tScore >= 2 &&
      cons >= 0.82 &&
      (
        engine === "EXPLOSIE"
          ? (volAcc >= CFG.engines.EXPLOSIE.buildUpVolAccMin)
          : (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax)
      );

    const almostOk =
      buildupOk &&
      passStageMin(c, "ALMOST") &&
      (
        engine === "EXPLOSIE"
          ? (flat != null && flat <= CFG.engines.EXPLOSIE.priceFlatMax)
          : (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax)
      );

    const entryBase =
      almostOk &&
      passStageMin(c, "ENTRY") &&
      mem.totalScans >= CFG.funnel.minTotalScansForEntry &&
      tScore >= 3;

    const entryGateOk =
      engine === "EXPLOSIE"
        ? (regimeInfo.regime === "HIGH_VOL" && volAcc >= CFG.engines.EXPLOSIE.entryVolAccMin)
        : (regimeInfo.regime === "GRIND" && flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax);

    let desired = "RADAR";
    if (buildupOk) desired = "BUILDUP";
    if (almostOk) desired = "ALMOST";
    if (entryBase && entryGateOk) desired = "ENTRY";

    const nextStage = CFG.funnel.promoteOneStep ? moveOneStep(mem.stage, desired) : desired;
    if (nextStage === mem.stage) mem.scansInStage += 1;
    else { mem.stage = nextStage; mem.scansInStage = 1; }

    if (mem.stage === "BUILDUP" && mem.scansInStage < CFG.funnel.minBuildUpScans) {
      mem.lastExplain = `BUILDUP bevestiging: ${mem.scansInStage}/${CFG.funnel.minBuildUpScans}`;
    } else {
      mem.lastExplain = `OK: timing=${tScore}/4 cons=${Math.round(cons*100)}% volAcc=${Math.round(volAcc*100)}% flat=${flat==null?"n/a":flat.toFixed(2)+"%"}`;
    }

    const row = baseRow(c, side, mem, regimeInfo, engine, cons, volAcc, flat);
    row.desiredStage = desired;
    row.explain = mem.lastExplain;

    // OB alleen Almost/Entry
    if ((row.finalStage === "ALMOST" || row.finalStage === "ENTRY") && obCalls < CFG.ob.maxCallsPerScan) {
      const bg = bitgetMap?.[row.symbol];
      if (bg) {
        try {
          const obRaw = await fetchOB(bg, CFG.ob.depthLimit);
          const m = calcObMetrics(obRaw, row.price, CFG.ob.depthPct);
          if (m) {
            row.ob = { source: "bitget_spot", symbol: bg, depthPct: CFG.ob.depthPct, ...m };
            obCalls++;
            await sleep(120);
          }
        } catch {}
      }
    }

    // ENTRY moet OB bevestiging hebben, anders terug naar ALMOST
    if (row.finalStage === "ENTRY") {
      const okOb = obPassForEntry(side, engine, row?.ob?.score);
      if (!okOb) {
        row.finalStage = "ALMOST";
        mem.stage = "ALMOST";
        mem.scansInStage = 1;
        mem.lastExplain = "ENTRY afgekeurd: OB ontbreekt/te zwak → terug naar ALMOST";
        row.explain = mem.lastExplain;
      } else {
        const exp = expectancyProxy(row);
        const sp = sizingPlan(engine, exp);
        row.risk = { sizingLabel: sp.label, suggestedSizePct: sp.suggestedSizePct, expectancyProxy: Number(exp.toFixed(3)) };
        row.tradePlan = tradePlan(engine);
      }
    }

    await redis.set(memKey, mem);
    putRow(side, row, bull, bear);
  }

  // sort: entry bovenaan
  const sortRows = (a,b) => {
    const ao = (a.ob?.score ?? 0), bo = (b.ob?.score ?? 0);
    const av = (a.vm||0) + (a.volAcceleration||0) + (ao*0.5);
    const bv = (b.vm||0) + (b.volAcceleration||0) + (bo*0.5);
    return bv - av;
  };
  for (const k of Object.keys(bull)) bull[k].sort(sortRows);
  for (const k of Object.keys(bear)) bear[k].sort(sortRows);

  const outBull = {
    side: "BULL",
    ts,
    regime: regimeInfo,
    meta: { coinsAfterPool: coins.length, obCalls },
    stageMin: CFG.stageMin,
    bands: CFG.bands,
    tables: bull
  };
  const outBear = {
    side: "BEAR",
    ts,
    regime: regimeInfo,
    meta: { coinsAfterPool: coins.length, obCalls },
    stageMin: CFG.stageMin,
    bands: CFG.bands,
    tables: bear
  };

  await redis.set("out:bull:v1", outBull);
  await redis.set("out:bear:v1", outBear);
  await redis.set("out:lastTs:v1", ts);

  return { ok: true, ts, coins: coins.length, obCalls, regime: regimeInfo };
}

function baseRow(c, side, mem, regimeInfo, engine, cons, volAcc, flat) {
  return {
    id: c.id,
    symbol: c.symbol,
    name: c.name,
    price: c.price,
    mcap: c.mcap,
    vol24h: c.vol,
    vm: c.vm,
    ch24: c.ch24,
    rangePct: c.range,
    ctl: c.ctl,
    side,
    regime: regimeInfo.regime,
    btcRange24h: regimeInfo.btcRange24h,
    engine,
    desiredStage: mem.stage,
    finalStage: mem.stage,
    scansInStage: mem.scansInStage,
    totalScans: mem.totalScans,
    consistency: cons,
    volAcceleration: volAcc,
    priceFlatPct: flat,
    ob: null,
    risk: null,
    tradePlan: null,
    explain: ""
  };
}

function entryState(side, row) {
  const ob = row.ob;
  const spread = ob?.spreadPct;
  if (!ob || spread == null) return "ENTRY";
  // simpel houden: we gebruiken alleen score + spread om HOLD/SELL te labelen
  if (side === "BULL") {
    if (ob.score <= -0.10 && spread >= 0.35) return "SELL";
    if (ob.score >=  0.18 && spread <= 0.28) return "HOLD";
    return "ENTRY";
  } else {
    if (ob.score >=  0.10 && spread >= 0.35) return "SELL";
    if (ob.score <= -0.18 && spread <= 0.28) return "HOLD";
    return "ENTRY";
  }
}

function putRow(side, row, bull, bear) {
  const bucket = (side === "BULL") ? bull : bear;

  if (row.finalStage === "RADAR") bucket.radar.push(row);
  else if (row.finalStage === "BUILDUP") bucket.buildup.push(row);
  else if (row.finalStage === "ALMOST") bucket.almost.push(row);
  else if (row.finalStage === "ENTRY") {
    const st = entryState(side, row);
    if (st === "HOLD") bucket.entry_hold.push(row);
    else if (st === "SELL") bucket.entry_sell.push(row);
    else bucket.entry_entry.push(row);
  } else {
    bucket.radar.push(row);
  }
}
