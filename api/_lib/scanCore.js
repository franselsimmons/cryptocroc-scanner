import { getRedis } from "./redis.js";
import { fetchJson, n, sleep, percentile, meanStd } from "./utils.js";
import { loadBitgetUsdtSpotMap, fetchBitgetOrderbookSpot, calcObMetrics } from "./bitget.js";

const STAGES = ["RADAR", "BUILDUP", "ALMOST", "ENTRY"];
const stageIndex = (s) => Math.max(0, STAGES.indexOf(s || "RADAR"));

function moveOneStep(cur, desired) {
  const ci = stageIndex(cur);
  const di = stageIndex(desired);
  if (di > ci) return STAGES[ci + 1] || cur;
  if (di < ci) return STAGES[Math.max(0, ci - 1)] || cur;
  return cur;
}

function rangePct(high, low) {
  const h = n(high), l = n(low);
  if (h == null || l == null || l <= 0) return null;
  return ((h - l) / l) * 100;
}
function vmRatio(vol, mcap) {
  const v = n(vol), m = n(mcap);
  if (v == null || m == null || m <= 0) return null;
  return v / m;
}
function ctlProxy(price, high, low) {
  const p = n(price), h = n(high), l = n(low);
  if (p == null || h == null || l == null) return null;
  const d = h - l;
  if (d <= 0) return null;
  return (p - l) / d; // 0..1
}

function initMem(symbol) {
  return {
    symbol,
    stage: "RADAR",
    totalScans: 0,
    scansInStage: 0,
    lastSeen: null,
    hist: [], // last 12
    lastExplain: ""
  };
}
function pushHist(mem, row) {
  mem.hist.push(row);
  if (mem.hist.length > 12) mem.hist.shift();
}
function calcConsistency(mem) {
  const last = mem.hist.slice(-6);
  if (last.length === 0) return 0;
  const ok = last.filter((x) => x.passSide === true).length;
  return ok / last.length;
}
function calcVolAcceleration(mem) {
  const h = mem.hist.slice(-6);
  if (h.length < 6) return 0;
  const a = h.slice(0, 3).reduce((s, x) => s + (x.vol || 0), 0) / 3;
  const b = h.slice(3, 6).reduce((s, x) => s + (x.vol || 0), 0) / 3;
  if (a <= 0) return 0;
  return (b - a) / a;
}
function calcPriceFlat(mem) {
  const h = mem.hist.slice(-6).map((x) => x.price).filter((v) => Number.isFinite(v));
  if (h.length < 3) return null;
  const mn = Math.min(...h);
  const mx = Math.max(...h);
  if (mn <= 0) return null;
  return ((mx - mn) / mn) * 100;
}

async function detectRegime() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1&sparkline=false";
  const data = await fetchJson(url, 4);
  const btc = Array.isArray(data) ? data[0] : null;
  const r = rangePct(btc?.high_24h, btc?.low_24h);
  const btcRange24h = r == null ? 0 : r;
  const regime = (btcRange24h > 4.5) ? "HIGH_VOL" : "GRIND";
  return { regime, btcRange24h, source: "btc_range_24h" };
}

function pickEngine(regime, volAcc, flat) {
  if (regime === "HIGH_VOL") {
    if (volAcc >= 0.20) return "EXPLOSIE";
    return "ACCUMULATIE";
  }
  if (flat != null && flat <= 3.5) return "ACCUMULATIE";
  return "EXPLOSIE";
}

// Timing score 0..4
function timingScore(side, c, vmBuildupMin = 0.14) {
  let s = 0;
  if (side === "BULL") {
    if (c.ch24 != null && c.ch24 > 0) s++;
    if (c.vm != null && c.vm >= vmBuildupMin) s++;
    if (c.range != null && c.range >= 4.2 && c.range <= 25) s++;
    if (c.ctl != null && c.ctl >= 0.70) s++;
  } else {
    if (c.ch24 != null && c.ch24 < 0) s++;
    if (c.vm != null && c.vm >= vmBuildupMin) s++;
    if (c.range != null && c.range >= 4.2 && c.range <= 25) s++;
    if (c.ctl != null && c.ctl <= 0.30) s++;
  }
  return s;
}

// ENTRY/HOLD/SELL (ob + spread)
function entryState(side, ob, cfg) {
  if (!ob || ob.spreadPct == null) return "ENTRY";
  const spread = ob.spreadPct;
  if (side === "BULL") {
    if (ob.score <= cfg.ob.bullSellScore && spread >= cfg.ob.sellSpreadPct) return "SELL";
    if (ob.score >= cfg.ob.bullHoldScore && spread <= cfg.ob.holdSpreadPct) return "HOLD";
    return "ENTRY";
  } else {
    if (ob.score >= cfg.ob.bearSellScore && spread >= cfg.ob.sellSpreadPct) return "SELL";
    if (ob.score <= cfg.ob.bearHoldScore && spread <= cfg.ob.holdSpreadPct) return "HOLD";
    return "ENTRY";
  }
}

// OB z-score opslag per coin
async function updateObHistory(redis, side, symbol, obScore) {
  const key = `ob:${side}:${symbol}`;
  const cur = await redis.get(key);
  const arr = Array.isArray(cur?.scores) ? cur.scores : [];
  arr.push(obScore);
  while (arr.length > 50) arr.shift();
  await redis.set(key, { scores: arr, ts: Date.now() });
  return arr;
}

export async function runFullScan() {
  const redis = getRedis();
  const ts = new Date().toISOString();

  // Lock (voorkom dubbele scan)
  const locked = await redis.set("scan:lock", ts, { nx: true, ex: 180 });
  if (!locked) return { ok: true, skipped: true, reason: "locked" };

  const CFG = {
    cg: {
      vs: "usd",
      order: "volume_desc",
      perPage: 250,
      pages: Math.max(1, Math.min(2, Number(process.env.CG_PAGES || "2"))),
      delayBetweenPagesMs: 850
    },

    pool: {
      mcapMin: 3_000_000,
      mcapMax: 400_000_000,
      volMin: 250_000,
      vmMin: 0.10
    },

    // stage minima (RADAR breed -> ENTRY streng)
    stageMin: {
      RADAR:   { volMin: 250_000,  vmMin: 0.10 },
      BUILDUP: { volMin: 500_000,  vmMin: 0.14 },
      ALMOST:  { volMin: 1_000_000, vmMin: 0.16 },
      ENTRY:   { volMin: 1_500_000, vmMin: 0.28 }
    },

    funnel: {
      minScansToLeaveRadar: 2,
      minBuildUpScans: 3,
      minTotalScansForEntry: 5,
      promoteOneStep: true,
      demoteOneStep: true
    },

    engines: {
      EXPLOSIE: {
        buildUpVolAccMin: 0.20,
        entryVolAccMin: 0.30,
        priceFlatMax: 4.0
      },
      ACCUMULATIE: {
        priceFlatMax: 3.0
      }
    },

    // PRO OB vanaf ALMOST + ENTRY
    ob: {
      depthLimit: 20,
      depthPct: 0.02,
      maxCalls: Math.max(10, Math.min(60, Number(process.env.OB_MAX_CALLS || "40"))),

      // ENTRY moet OB z-score halen
      zBull: 1.0,
      zBear: -1.0,

      // ENTRY/HOLD/SELL thresholds
      sellSpreadPct: 0.35,
      holdSpreadPct: 0.28,

      bullHoldScore: 0.18,
      bullSellScore: -0.10,

      bearHoldScore: -0.18,
      bearSellScore: 0.10
    }
  };

  function passPool(c) {
    return (
      c.mcap >= CFG.pool.mcapMin &&
      c.mcap <= CFG.pool.mcapMax &&
      c.vol  >= CFG.pool.volMin &&
      c.vm   >= CFG.pool.vmMin
    );
  }
  function passStageMin(c, stage) {
    const t = CFG.stageMin[stage];
    if (!t) return false;
    return (c.vol >= t.volMin) && (c.vm >= t.vmMin);
  }

  try {
    const regimeInfo = await detectRegime();

    // Bitget symbol map (cached in redis)
    const bitgetMap = await loadBitgetUsdtSpotMap(redis);

    // 1) Fetch coins (250/500)
    const all = [];
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
      if (!Array.isArray(data) || data.length === 0) break;

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
          vol:  n(x.total_volume),
          high: n(x.high_24h),
          low:  n(x.low_24h),
          ch24: n(x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h)
        };

        c.range = rangePct(c.high, c.low);
        c.vm = vmRatio(c.vol, c.mcap);
        c.ctl = ctlProxy(c.price, c.high, c.low);

        if (!sym || c.price == null || c.mcap == null || c.vol == null || c.vm == null || c.ch24 == null) continue;
        if (!passPool(c)) continue;

        all.push(c);
      }

      await sleep(CFG.cg.delayBetweenPagesMs);
    }

    // 2) Dynamic bands (10e/90e) van pool coins
    const allCh24 = all.map((c) => c.ch24).filter((v) => Number.isFinite(v));
    const lowBand = percentile(allCh24, 0.10);
    const highBand = percentile(allCh24, 0.90);

    function decideSide(ch24) {
      if (ch24 == null || lowBand == null || highBand == null) return null;
      if (ch24 >= highBand) return "BULL";
      if (ch24 <= lowBand) return "BEAR";
      return null;
    }

    // output buckets
    const bull = { entry_entry: [], entry_hold: [], entry_sell: [], almost: [], buildup: [], radar: [] };
    const bear = { entry_entry: [], entry_hold: [], entry_sell: [], almost: [], buildup: [], radar: [] };

    let obCalls = 0;

    // 3) process coins
    for (const c of all) {
      const side = decideSide(c.ch24);
      if (!side) continue;

      const memKey = `mem:${side}:${c.symbol}`;
      const memRaw = await redis.get(memKey);
      const mem = memRaw ? memRaw : initMem(c.symbol);

      // passSide = RADAR minima + in side (side is al bepaald door band)
      const passSide = passStageMin(c, "RADAR");

      // update memory hist
      mem.totalScans = Number(mem.totalScans || 0) + 1;
      mem.lastSeen = ts;
      mem.stage = mem.stage || "RADAR";
      mem.scansInStage = Number(mem.scansInStage || 0);

      pushHist(mem, { ts, price: c.price, vol: c.vol, vm: c.vm, passSide });

      const cons = calcConsistency(mem);
      const volAcc = calcVolAcceleration(mem);
      const flat = calcPriceFlat(mem);
      const engine = pickEngine(regimeInfo.regime, volAcc, flat);

      // base row
      const row = {
        id: c.id, symbol: c.symbol, name: c.name, price: c.price,
        mcap: c.mcap, vol24h: c.vol, vm: c.vm, ch24: c.ch24,
        rangePct: c.range, ctl: c.ctl,
        side, regime: regimeInfo.regime, btcRange24h: regimeInfo.btcRange24h,
        engine,
        desiredStage: "RADAR",
        finalStage: mem.stage,
        scansInStage: mem.scansInStage,
        totalScans: mem.totalScans,
        consistency: cons,
        volAcceleration: volAcc,
        priceFlatPct: flat,
        ob: null,
        obZ: null,
        explain: ""
      };

      // FIX: nieuwe coin altijd RADAR zichtbaar
      if (mem.totalScans === 1) {
        mem.stage = "RADAR";
        mem.scansInStage = 1;
        row.desiredStage = "RADAR";
        row.finalStage = "RADAR";
        row.scansInStage = 1;
        row.explain = `Nieuw → RADAR lock (1/${CFG.funnel.minScansToLeaveRadar})`;
        await redis.set(memKey, mem);
        (side === "BULL" ? bull.radar : bear.radar).push(row);
        continue;
      }

      // fail RADAR basis => demote 1 step + niet tonen
      if (!passSide) {
        const curI = stageIndex(mem.stage);
        mem.stage = CFG.funnel.demoteOneStep ? STAGES[Math.max(0, curI - 1)] : "RADAR";
        mem.scansInStage = 1;
        mem.lastExplain = "Faalt RADAR minima → 1 stap terug (hidden).";
        await redis.set(memKey, mem);
        continue;
      }

      // RADAR lock (min 2 scans in radar)
      if (mem.stage === "RADAR" && mem.totalScans < CFG.funnel.minScansToLeaveRadar) {
        mem.scansInStage += 1;
        row.finalStage = "RADAR";
        row.scansInStage = mem.scansInStage;
        row.desiredStage = "RADAR";
        row.explain = `RADAR lock (${mem.totalScans}/${CFG.funnel.minScansToLeaveRadar})`;
        await redis.set(memKey, mem);
        (side === "BULL" ? bull.radar : bear.radar).push(row);
        continue;
      }

      // Desired stage logic
      const tScore = timingScore(side, c, CFG.stageMin.BUILDUP.vmMin);

      const buildupMinOk = passStageMin(c, "BUILDUP");
      const buildupCoreOk = buildupMinOk && (tScore >= 2) && (cons >= 0.82);

      let buildupEngineOk = false;
      if (engine === "EXPLOSIE") {
        buildupEngineOk = volAcc >= CFG.engines.EXPLOSIE.buildUpVolAccMin;
      } else {
        buildupEngineOk = (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax);
      }

      const almostMinOk = passStageMin(c, "ALMOST");
      let almostOk = false;
      if (engine === "EXPLOSIE") {
        almostOk = (flat != null && flat <= CFG.engines.EXPLOSIE.priceFlatMax && volAcc >= CFG.engines.EXPLOSIE.buildUpVolAccMin);
      } else {
        almostOk = (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax);
      }

      const entryMinOk = passStageMin(c, "ENTRY");
      const entryBaseOk = entryMinOk && (mem.totalScans >= CFG.funnel.minTotalScansForEntry) && (tScore >= 3);

      let entryGateOk = false;
      if (engine === "EXPLOSIE") {
        entryGateOk = (regimeInfo.regime === "HIGH_VOL") && (volAcc >= CFG.engines.EXPLOSIE.entryVolAccMin);
      } else {
        entryGateOk = (regimeInfo.regime === "GRIND") && (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax);
      }

      let desired = "RADAR";
      if (buildupCoreOk && buildupEngineOk) desired = "BUILDUP";
      if (desired === "BUILDUP" && almostMinOk && almostOk) desired = "ALMOST";
      if (desired === "ALMOST" && entryBaseOk && entryGateOk) desired = "ENTRY";

      // promote/demote max 1 step
      const nextStage = CFG.funnel.promoteOneStep ? moveOneStep(mem.stage, desired) : desired;

      if (nextStage === mem.stage) mem.scansInStage += 1;
      else { mem.stage = nextStage; mem.scansInStage = 1; }

      // BUILDUP lock
      if (mem.stage === "BUILDUP" && mem.scansInStage < CFG.funnel.minBuildUpScans) {
        mem.lastExplain = `BUILDUP bevestiging (${mem.scansInStage}/${CFG.funnel.minBuildUpScans})`;
      } else {
        mem.lastExplain = `timing=${tScore}/4 cons=${Math.round(cons * 100)}% volAcc=${Math.round(volAcc * 100)}% flat=${flat == null ? "n/a" : flat.toFixed(2) + "%"}`;
      }

      row.desiredStage = desired;
      row.finalStage = mem.stage;
      row.scansInStage = mem.scansInStage;
      row.explain = mem.lastExplain;

      // PRO OB vanaf ALMOST + ENTRY
      if ((row.finalStage === "ALMOST" || row.finalStage === "ENTRY") && obCalls < CFG.ob.maxCalls) {
        const bgSym = bitgetMap?.[row.symbol];
        if (bgSym) {
          try {
            const obRaw = await fetchBitgetOrderbookSpot(bgSym, CFG.ob.depthLimit);
            const m = calcObMetrics(obRaw, row.price, CFG.ob.depthPct);
            if (m) {
              row.ob = {
                source: "bitget_spot",
                symbol: bgSym,
                depthPct: CFG.ob.depthPct,
                score: m.score,
                spreadPct: m.spreadPct,
                bidUsd: m.bidUsd,
                askUsd: m.askUsd
              };

              const scores = await updateObHistory(redis, side, row.symbol, m.score);
              const { mean, std } = meanStd(scores);
              const z = (m.score - mean) / (std || 1);
              row.obZ = Number(z.toFixed(3));
              obCalls++;
              await sleep(140);
            }
          } catch {
            // ignore
          }
        }
      }

      // ENTRY vereist OB-confirm (z-score)
      if (row.finalStage === "ENTRY") {
        const z = row.obZ;
        const ok = (side === "BULL")
          ? (z != null && z >= CFG.ob.zBull)
          : (z != null && z <= CFG.ob.zBear);

        if (!ok) {
          row.finalStage = "ALMOST";
          mem.stage = "ALMOST";
          mem.scansInStage = 1;
          mem.lastExplain = "ENTRY afgekeurd: OB z-score te zwak → terug naar ALMOST";
          row.explain = mem.lastExplain;
        }
      }

      await redis.set(memKey, mem);

      // bucket + ENTRY split (ENTRY/HOLD/SELL)
      const bucket = (side === "BULL") ? bull : bear;

      if (row.finalStage === "RADAR") bucket.radar.push(row);
      else if (row.finalStage === "BUILDUP") bucket.buildup.push(row);
      else if (row.finalStage === "ALMOST") bucket.almost.push(row);
      else if (row.finalStage === "ENTRY") {
        const st = entryState(side, row.ob, CFG);
        if (st === "HOLD") bucket.entry_hold.push(row);
        else if (st === "SELL") bucket.entry_sell.push(row);
        else bucket.entry_entry.push(row);
      } else bucket.radar.push(row);
    }

    // sort: vm + volAcc + obscore
    function sortRows(a, b) {
      const ao = (a.ob?.score ?? 0);
      const bo = (b.ob?.score ?? 0);
      const av = (a.vm || 0) + (a.volAcceleration || 0) + (ao * 0.5);
      const bv = (b.vm || 0) + (b.volAcceleration || 0) + (bo * 0.5);
      return bv - av;
    }
    for (const k of Object.keys(bull)) bull[k].sort(sortRows);
    for (const k of Object.keys(bear)) bear[k].sort(sortRows);

    const meta = {
      ts,
      coinsAfterPool: all.length,
      bands: { lowBand, highBand, method: "10/90 percentiel van pool ch24" },
      regime: regimeInfo,
      stageMin: CFG.stageMin,
      notes: {
        rule1: "Nieuwe coin altijd zichtbaar in RADAR met lock.",
        rule2: "Side via dynamische bands (10/90), niet +/- teken.",
        rule3: "Stage minima per level (RADAR breed -> ENTRY streng).",
        rule4: "Orderbook PRO vanaf ALMOST + ENTRY. ENTRY vereist OB z-score confirm.",
        rule5: "ENTRY split: ENTRY/HOLD/SELL via OB+spread."
      }
    };

    const outBull = { ok: true, side: "BULL", ...meta, tables: bull };
    const outBear = { ok: true, side: "BEAR", ...meta, tables: bear };

    await redis.set("out:bull", outBull);
    await redis.set("out:bear", outBear);
    await redis.set("out:lastTs", ts);

    return { ok: true, ts, coinsAfterPool: all.length, obCalls, lowBand, highBand, regime: regimeInfo.regime };
  } finally {
    await redis.del("scan:lock");
  }
}
