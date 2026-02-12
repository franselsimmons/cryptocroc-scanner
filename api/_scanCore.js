import { kv } from "@vercel/kv";
import { fetchFn, percentile, kvGetJson, kvSetJson, asNum, nowTs, clamp, cleanSymbol } from "./_util.js";

const CFG = {
  mcapMin: 3_000_000,
  mcapMax: 400_000_000,
  volMin: 250_000,
  vmMin: 0.10,

  minScansToLeaveRadar: 2,
  minTotalScansForEntry: 5,

  buildUpConsistencyMin: 0.82,
  buildUpVolAccMin: 0.20,
  entryVolAccMin: 0.30,

  entryVolMin: 1_500_000,
  entryVmMin: 0.28,

  flatMaxAccu: 0.03,   // 3%
  flatMaxExpl: 0.04,   // 4%

  // zscore gate
  zBull: 1.0,
  zBear: -1.0
};

function timingScore(side, c) {
  // c: { ch24, vm, rangePct, ctl }
  let s = 0;

  if (side === "BULL") {
    if (c.ch24 > 0) s++;
    if (c.vm >= 0.14) s++;
    if (c.rangePct >= 0.042 && c.rangePct <= 0.25) s++;
    if (c.ctl >= 0.70) s++;
  } else {
    if (c.ch24 < 0) s++;
    if (c.vm >= 0.14) s++;
    if (c.rangePct >= 0.042 && c.rangePct <= 0.25) s++;
    if (c.ctl <= 0.30) s++;
  }

  return s;
}

function computeDerived(hist) {
  // laatste 6 scans
  const last6 = hist.slice(-6);
  const passSideCnt = last6.filter(x => x.passSide).length;
  const consistency = last6.length ? passSideCnt / last6.length : 0;

  // volAcc: avg(last3) vs avg(prev3)
  const last3 = last6.slice(-3);
  const prev3 = last6.slice(0, Math.max(0, last6.length - 3));
  const avg = (arr, k) => {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + asNum(b?.[k], 0), 0) / arr.length;
  };
  const aLast = avg(last3, "vol");
  const aPrev = avg(prev3, "vol");
  const volAcc = aPrev > 0 ? (aLast - aPrev) / aPrev : 0;

  // flatness: (max-min)/min over last6 prices
  const prices = last6.map(x => asNum(x.price, 0)).filter(Boolean);
  let flat = null;
  if (prices.length >= 3) {
    const mn = Math.min(...prices);
    const mx = Math.max(...prices);
    flat = mn > 0 ? (mx - mn) / mn : null;
  }

  return { consistency, volAcc, flat };
}

function decideEngine(regime, flat) {
  // simpel: HIGH_VOL => EXPLOSIE, anders ACCUMULATIE
  // (kan later uitgebreider)
  return regime === "HIGH_VOL" ? "EXPLOSIE" : "ACCUMULATIE";
}

function stageFromMemory(mem, nowCoin, derived, side, regime) {
  const totalScans = mem.totalScans || 0;
  const scansInStage = mem.scansInStage || 0;
  const curStage = mem.stage || "RADAR";

  const ts = nowCoin.timingScore;

  // eerst: minimaal RADAR “vasthouden”
  if (curStage === "RADAR") {
    if (scansInStage + 1 < CFG.minScansToLeaveRadar) return "RADAR";
  }

  // BUILDUP gate
  const canBuild =
    totalScans >= 2 &&
    nowCoin.passSide &&
    ts >= 2 &&
    derived.consistency >= CFG.buildUpConsistencyMin;

  const engine = decideEngine(regime, derived.flat);

  const buildOk =
    engine === "EXPLOSIE"
      ? derived.volAcc >= CFG.buildUpVolAccMin
      : (derived.flat !== null && derived.flat <= CFG.flatMaxAccu);

  // ALMOST gate
  const almostOk =
    ts >= 2 &&
    derived.flat !== null &&
    (engine === "EXPLOSIE"
      ? (derived.flat <= CFG.flatMaxExpl && derived.volAcc >= CFG.buildUpVolAccMin)
      : (derived.flat <= CFG.flatMaxAccu));

  // ENTRY base gate (zonder OB)
  const entryBase =
    nowCoin.vol >= CFG.entryVolMin &&
    nowCoin.vm >= CFG.entryVmMin &&
    totalScans >= CFG.minTotalScansForEntry &&
    ts >= 3 &&
    (engine === "EXPLOSIE" ? regime === "HIGH_VOL" : regime === "GRIND") &&
    (engine === "EXPLOSIE" ? derived.volAcc >= CFG.entryVolAccMin : derived.flat <= CFG.flatMaxAccu);

  // stage flow: max 1 stap per scan
  if (curStage === "RADAR") {
    return canBuild && buildOk ? "BUILDUP" : "RADAR";
  }
  if (curStage === "BUILDUP") {
    return almostOk ? "ALMOST" : (canBuild ? "BUILDUP" : "RADAR");
  }
  if (curStage === "ALMOST") {
    return entryBase ? "ENTRY_PENDING_OB" : (almostOk ? "ALMOST" : "BUILDUP");
  }
  if (curStage === "ENTRY") {
    // blijft entry zolang base ok, anders terug
    return entryBase ? "ENTRY" : "ALMOST";
  }

  return "RADAR";
}

async function cgMarkets(pages = 2) {
  const out = [];
  for (let p = 1; p <= pages; p++) {
    const url =
      "https://api.coingecko.com/api/v3/coins/markets" +
      `?vs_currency=usd&order=volume_desc&per_page=250&page=${p}` +
      "&sparkline=false&price_change_percentage=24h";
    const r = await fetchFn(url);
    if (!r.ok) continue;
    const j = await r.json();
    if (Array.isArray(j)) out.push(...j);
  }
  return out;
}

function poolFilter(c) {
  const mcap = asNum(c.market_cap, 0);
  const vol = asNum(c.total_volume, 0);
  const vm = mcap > 0 ? vol / mcap : 0;

  if (mcap < CFG.mcapMin) return null;
  if (mcap > CFG.mcapMax) return null;
  if (vol < CFG.volMin) return null;
  if (vm < CFG.vmMin) return null;

  const price = asNum(c.current_price, 0);
  const ch24 = asNum(c.price_change_percentage_24h, 0) / 100; // ratio
  const hi = asNum(c.high_24h, 0);
  const lo = asNum(c.low_24h, 0);
  const rangePct = lo > 0 ? (hi - lo) / lo : 0;

  // ctl: close-to-(low/high) simpele proxy
  // 0 => dicht bij low, 1 => dicht bij high
  const ctl = (hi > lo) ? clamp((price - lo) / (hi - lo), 0, 1) : 0.5;

  const symbol = cleanSymbol(c.symbol);

  return { symbol, price, mcap, vol, vm, ch24, rangePct, ctl };
}

export async function runScan(side, regime, reset = false) {
  if (reset) {
    // reset: alleen jouw app keys (veilig)
    // we wissen funnel memory keys door prefix te gebruiken
    // (KV heeft geen wildcard delete; we doen een "global reset flag" per side)
    await kvSetJson(`resetFlag:${side}`, { ts: nowTs() }, 60 * 60);
  }

  const resetFlag = await kvGetJson(`resetFlag:${side}`, null);

  const markets = await cgMarkets(2);
  const pooled = markets.map(poolFilter).filter(Boolean);

  // bands op basis van pooled ch24
  const ch = pooled.map(x => x.ch24).slice().sort((a, b) => a - b);
  const lowBand = percentile(ch, 0.10);
  const highBand = percentile(ch, 0.90);

  const picked =
    side === "BULL"
      ? pooled.filter(x => x.ch24 >= highBand)
      : pooled.filter(x => x.ch24 <= lowBand);

  // memory + stage
  const funnel = { ENTRY: [], ALMOST: [], BUILDUP: [], RADAR: [] };

  for (const c of picked) {
    const memKey = `mem:${side}:${c.symbol}`;
    let mem = await kvGetJson(memKey, { stage: "RADAR", totalScans: 0, scansInStage: 0, hist: [] });

    // als resetFlag bestaat en mem ouder is => reset deze coin
    if (resetFlag && mem?.lastTs && mem.lastTs < resetFlag.ts) {
      mem = { stage: "RADAR", totalScans: 0, scansInStage: 0, hist: [] };
    }

    const passSide = true; // deze lijst is al side-filtered
    const ts = timingScore(side, c);

    const row = {
      ts: nowTs(),
      price: c.price,
      vol: c.vol,
      vm: c.vm,
      passSide
    };

    const hist = Array.isArray(mem.hist) ? mem.hist : [];
    hist.push(row);
    while (hist.length > 30) hist.shift();

    const derived = computeDerived(hist);

    const nextStageRaw = stageFromMemory(
      mem,
      { ...c, timingScore: ts, passSide },
      derived,
      side,
      regime
    );

    // ENTRY_PENDING_OB is UI/logic stage (nog niet echt entry)
    const cur = mem.stage || "RADAR";
    const nextStage =
      nextStageRaw === "ENTRY_PENDING_OB" ? "ALMOST" : nextStageRaw;

    const scansInStage =
      nextStage === cur ? (asNum(mem.scansInStage, 0) + 1) : 1;

    const totalScans = asNum(mem.totalScans, 0) + 1;

    const out = {
      symbol: c.symbol,
      price: c.price,
      ch24: c.ch24,
      vol: c.vol,
      vm: c.vm,
      rangePct: c.rangePct,
      ctl: c.ctl,
      timingScore: ts,
      stage: nextStage,
      totalScans,
      scansInStage,
      consistency: derived.consistency,
      volAcc: derived.volAcc,
      flat: derived.flat,
      engine: decideEngine(regime, derived.flat)
    };

    await kvSetJson(memKey, { stage: nextStage, totalScans, scansInStage, hist, lastTs: nowTs() });

    funnel[nextStage].push(out);
  }

  // Sort: belangrijkst bovenaan (ENTRY->... + binnen stage op timing/vm/vol)
  const sorter = (a, b) =>
    (b.timingScore - a.timingScore) ||
    (b.vm - a.vm) ||
    (b.vol - a.vol);

  for (const k of Object.keys(funnel)) funnel[k].sort(sorter);

  return {
    ok: true,
    side,
    regime,
    bands: { lowBand, highBand },
    counts: {
      ENTRY: funnel.ENTRY.length,
      ALMOST: funnel.ALMOST.length,
      BUILDUP: funnel.BUILDUP.length,
      RADAR: funnel.RADAR.length
    },
    funnel
  };
}
