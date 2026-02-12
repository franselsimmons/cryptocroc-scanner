import { CFG } from "./config.js";
import { fetchJson, sleep, n } from "./utils.js";
import {
  enrichCoin, initMem, normalizeMem, pushHist,
  calcConsistency, calcVolAcceleration, calcPriceFlat,
  decideSideByBands, timingScore, STAGES, stageIndex, moveOneStep,
  entryStateFromOB
} from "./engine.js";
import { loadBitgetSpotUsdtMap, fetchBitgetOrderbook, calcObMetrics } from "./bitget.js";

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
  return c.vol >= t.volMin && c.vm >= t.vmMin;
}

function pickEngine(volAcc, flat) {
  // simpel en robuust (geen “regime” nodig om stabiel te draaien)
  if (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax) return "ACCUMULATIE";
  if (volAcc >= CFG.engines.EXPLOSIE.buildUpVolAccMin) return "EXPLOSIE";
  return "ACCUMULATIE";
}

function baseRow(c, side, mem, cons, volAcc, flat, engine) {
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
    engine,
    desiredStage: "RADAR",
    finalStage: mem.stage,
    scansInStage: mem.scansInStage,
    totalScans: mem.totalScans,
    consistency: cons,
    volAcceleration: volAcc,
    priceFlatPct: flat,
    ob: null,
    explain: mem.lastExplain || ""
  };
}

export async function runFullScan(redis) {
  const ts = new Date().toISOString();

  // lock (voorkomt dubbele scan)
  const locked = await redis.set("scan:lock", ts, { nx: true, ex: 180 });
  if (!locked) return { ok: true, skipped: true, reason: "locked" };

  try {
    // 1) CoinGecko top coins
    const all = [];
    const seen = new Set();

    for (let page = 1; page <= CFG.cg.pages; page++) {
      const url =
        "https://api.coingecko.com/api/v3/coins/markets" +
        `?vs_currency=${encodeURIComponent(CFG.cg.vs)}` +
        `&order=${encodeURIComponent(CFG.cg.order)}` +
        `&per_page=${encodeURIComponent(String(CFG.cg.perPage))}` +
        `&page=${encodeURIComponent(String(page))}` +
        `&sparkline=false&price_change_percentage=24h`;

      const data = await fetchJson(url, 4);
      if (!Array.isArray(data) || !data.length) break;

      for (const x of data) {
        if (!x?.id || seen.has(x.id)) continue;
        seen.add(x.id);

        const sym = (x.symbol || "").toUpperCase();
        const c0 = {
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
        if (!c0.symbol || c0.price == null || c0.mcap == null || c0.vol == null || c0.ch24 == null) continue;

        const c = enrichCoin(c0);
        if (c.vm == null || c.range == null || c.ctl == null) continue;
        if (!passPool(c)) continue;

        all.push(c);
      }

      await sleep(CFG.cg.delayMs);
    }

    // 2) Bitget symbol map (USDT)
    const bitgetMap = await loadBitgetSpotUsdtMap(redis);

    // 3) Output containers (ALTIJD correct gevuld -> geen push(undefined) crash)
    const bull = { entry_entry: [], entry_hold: [], entry_sell: [], almost: [], buildup: [], radar: [] };
    const bear = { entry_entry: [], entry_hold: [], entry_sell: [], almost: [], buildup: [], radar: [] };

    let obCalls = 0;

    for (const c of all) {
      const side = decideSideByBands(c.ch24, CFG.bands.bull, CFG.bands.bear);
      if (!side) continue;

      const memKey = `mem:${side}:${c.symbol}`;
      const memRaw = await redis.get(memKey);
      const mem = normalizeMem(memRaw || initMem(c.symbol), c.symbol);

      // passSide: RADAR minima + band match
      const passSide = passStageMin(c, "RADAR");

      mem.totalScans += 1;
      pushHist(mem, { ts, price: c.price, vol: c.vol, vm: c.vm, passSide });

      const cons = calcConsistency(mem);
      const volAcc = calcVolAcceleration(mem);
      const flat = calcPriceFlat(mem);
      const engine = pickEngine(volAcc, flat);

      // ✅ nieuwe coin -> direct RADAR output
      if (mem.totalScans === 1) {
        mem.stage = "RADAR";
        mem.scansInStage = 1;
        mem.lastExplain = `Nieuw → RADAR lock (1/${CFG.funnel.minScansToLeaveRadar})`;
        await redis.set(memKey, mem);

        const row = baseRow(c, side, mem, cons, volAcc, flat, engine);
        row.desiredStage = "RADAR";
        row.finalStage = "RADAR";
        row.explain = mem.lastExplain;

        if (side === "BULL") bull.radar.push(row); else bear.radar.push(row);
        continue;
      }

      // faalt basis -> 1 stap terug (of RADAR)
      if (!passSide) {
        const curI = stageIndex(mem.stage);
        const next = CFG.funnel.demoteOneStep ? STAGES[Math.max(0, curI - 1)] : "RADAR";
        mem.stage = next;
        mem.scansInStage = 1;
        mem.lastExplain = "Faalt RADAR basis → 1 stap terug.";
        await redis.set(memKey, mem);
        continue;
      }

      // RADAR lock
      if (mem.stage === "RADAR" && mem.totalScans < CFG.funnel.minScansToLeaveRadar) {
        mem.scansInStage += 1;
        mem.lastExplain = `RADAR lock (${mem.totalScans}/${CFG.funnel.minScansToLeaveRadar})`;
        await redis.set(memKey, mem);

        const row = baseRow(c, side, mem, cons, volAcc, flat, engine);
        row.desiredStage = "RADAR";
        row.finalStage = "RADAR";
        row.explain = mem.lastExplain;
        if (side === "BULL") bull.radar.push(row); else bear.radar.push(row);
        continue;
      }

      // stage logic
      const tScore = timingScore(side, c, CFG.stageMin.BUILDUP.vmMin);

      const buildupOk =
        passStageMin(c, "BUILDUP") &&
        tScore >= 2 &&
        cons >= 0.82 &&
        (engine === "EXPLOSIE" ? volAcc >= CFG.engines.EXPLOSIE.buildUpVolAccMin : (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax));

      const almostOk =
        passStageMin(c, "ALMOST") &&
        (flat != null) &&
        (engine === "EXPLOSIE" ? (flat <= CFG.engines.EXPLOSIE.priceFlatMax) : (flat <= CFG.engines.ACCUMULATIE.priceFlatMax));

      const entryBase =
        passStageMin(c, "ENTRY") &&
        mem.totalScans >= CFG.funnel.minTotalScansForEntry &&
        tScore >= 3;

      // ENTRY gate: EXPLOSIE = volAcc, ACCU = flat
      const entryGateOk =
        engine === "EXPLOSIE"
          ? (volAcc >= CFG.engines.EXPLOSIE.entryVolAccMin)
          : (flat != null && flat <= CFG.engines.ACCUMULATIE.priceFlatMax);

      let desired = "RADAR";
      if (buildupOk) desired = "BUILDUP";
      if (desired === "BUILDUP" && almostOk) desired = "ALMOST";
      if (desired === "ALMOST" && entryBase && entryGateOk) desired = "ENTRY";

      const nextStage = CFG.funnel.promoteOneStep ? moveOneStep(mem.stage, desired) : desired;
      if (nextStage === mem.stage) mem.scansInStage += 1;
      else { mem.stage = nextStage; mem.scansInStage = 1; }

      // BUILDUP confirm lock
      if (mem.stage === "BUILDUP" && mem.scansInStage < CFG.funnel.minBuildUpScans) {
        mem.lastExplain = `BUILDUP bevestiging (${mem.scansInStage}/${CFG.funnel.minBuildUpScans})`;
      } else {
        mem.lastExplain = `OK timing=${tScore}/4 cons=${Math.round(cons*100)}% volAcc=${Math.round(volAcc*100)}% flat=${flat==null?"n/a":flat.toFixed(2)+"%"}`;
      }

      await redis.set(memKey, mem);

      const row = baseRow(c, side, mem, cons, volAcc, flat, engine);
      row.desiredStage = desired;
      row.finalStage = mem.stage;
      row.explain = mem.lastExplain;

      // ✅ PRO: OB vanaf ALMOST + ENTRY (capped)
      if ((row.finalStage === "ALMOST" || row.finalStage === "ENTRY") && obCalls < CFG.ob.maxCallsPerScan) {
        const bgSym = bitgetMap?.[row.symbol]; // BASE -> SYMBOL (PEPE -> PEPEUSDT)
        if (bgSym) {
          try {
            const obRaw = await fetchBitgetOrderbook(bgSym, CFG.ob.depthLimit);
            const m = calcObMetrics(obRaw, row.price, CFG.ob.depthPct);
            if (m) {
              row.ob = {
                source: "bitget_v2_spot",
                symbol: bgSym,
                depthPct: CFG.ob.depthPct,
                score: m.score,
                spreadPct: m.spreadPct,
                bidUsd: m.bidUsd,
                askUsd: m.askUsd
              };
              obCalls += 1;
            }
          } catch {
            // stil
          }
        }
      }

      // ENTRY vereist OB “sterkte”, anders terug naar ALMOST
      if (row.finalStage === "ENTRY") {
        const obScore = row?.ob?.score;
        const okOb =
          (obScore != null) &&
          (engine === "EXPLOSIE"
            ? (side === "BULL" ? obScore >= CFG.engines.EXPLOSIE.entryObMinBull : obScore <= CFG.engines.EXPLOSIE.entryObMinBear)
            : (side === "BULL" ? obScore >= CFG.engines.ACCUMULATIE.entryObMinBull : obScore <= CFG.engines.ACCUMULATIE.entryObMinBear));

        if (!okOb) {
          row.finalStage = "ALMOST";
          row.explain = "ENTRY afgekeurd: OB ontbreekt/te zwak → terug naar ALMOST.";
          mem.stage = "ALMOST";
          mem.scansInStage = 1;
          mem.lastExplain = row.explain;
          await redis.set(memKey, mem);
        }
      }

      // bucket
      const bucket = (side === "BULL") ? bull : bear;

      if (row.finalStage === "RADAR") bucket.radar.push(row);
      else if (row.finalStage === "BUILDUP") bucket.buildup.push(row);
      else if (row.finalStage === "ALMOST") bucket.almost.push(row);
      else if (row.finalStage === "ENTRY") {
        const st = entryStateFromOB(side, row.ob, CFG.ob);
        if (st === "HOLD") bucket.entry_hold.push(row);
        else if (st === "SELL") bucket.entry_sell.push(row);
        else bucket.entry_entry.push(row);
      } else {
        bucket.radar.push(row);
      }
    }

    // sort (beste bovenaan)
    const sortRows = (a, b) => {
      const ao = a?.ob?.score ?? 0;
      const bo = b?.ob?.score ?? 0;
      const av = (a.vm || 0) + (a.volAcceleration || 0) + (ao * 0.5);
      const bv = (b.vm || 0) + (b.volAcceleration || 0) + (bo * 0.5);
      return bv - av;
    };

    for (const k of Object.keys(bull)) bull[k].sort(sortRows);
    for (const k of Object.keys(bear)) bear[k].sort(sortRows);

    const outBull = { ts, side: "BULL", coinsAfterPool: all.length, obCalls, tables: bull };
    const outBear = { ts, side: "BEAR", coinsAfterPool: all.length, obCalls, tables: bear };

    await redis.set("out:bull:v3", outBull);
    await redis.set("out:bear:v3", outBear);
    await redis.set("out:lastTs:v3", ts);

    return { ok: true, ts, coinsAfterPool: all.length, obCalls };
  } finally {
    await redis.del("scan:lock");
  }
}
