import { CFG, getCoinGeckoPool, getBitgetSpotSymbols, decideSide, loadMem, saveMem, timingScore, engineFor, calcFlatness, calcVolAcc, consistency, oneStepTransition, fetchBitgetOrderbook, calcObScore, zScoreFromHist, portfolioGate } from "./_core.js";
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

function json(res, code, obj){
  res.statusCode = code;
  res.setHeader("content-type","application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

function wantMode(req){
  const u = new URL(req.url, "http://localhost");
  const mode = (u.searchParams.get("mode") || "bull").toLowerCase();
  return (mode==="bear") ? "bear" : "bull";
}

async function scanOne(mode){
  // 1) CG pool
  const pool = await getCoinGeckoPool();

  // 2) bands & side filter
  const bands = decideSide(pool);
  const sided = pool.filter(c=>{
    if(bands.low==null || bands.high==null) return false;
    if(mode==="bull") return c.ch24 >= bands.high;
    return c.ch24 <= bands.low;
  });

  // 3) Bitget-only filter: match base to USDT symbol
  const bitget = await getBitgetSpotSymbols();
  const byBase = new Map();
  for(const s of bitget){
    if(s.base) byBase.set(s.base, s.symbol);
  }

  const candidates = [];
  for(const c of sided){
    const bg = byBase.get(c.symbol);
    if(!bg) continue;
    candidates.push({ ...c, bitgetSymbol:bg });
  }

  // 4) update memory + stage
  const funnel = { radar:[], buildup:[], almost:[], entry:[] };

  for(const c of candidates){
    const mem = await loadMem(mode, c.symbol);

    const passSide = true;
    const ts = Date.now();

    mem.hist = Array.isArray(mem.hist) ? mem.hist : [];
    mem.hist.push({ ts, price:c.price, vol:c.vol, vm:c.vm, passSide });

    // trim history
    if(mem.hist.length > CFG.memory.maxScans) mem.hist = mem.hist.slice(-CFG.memory.maxScans);

    mem.totalScans = (mem.totalScans || 0) + 1;

    const flat = calcFlatness(mem.hist);
    const volAcc = calcVolAcc(mem.hist);
    const cons = consistency(mem.hist);
    const tscore = timingScore(mode, c);
    const engine = engineFor(c);

    // stage rules
    let want = mem.stage || "RADAR";

    // RADAR minimum
    if(want==="RADAR"){
      mem.scansInStage = (mem.scansInStage||0)+1;
      if(mem.scansInStage >= CFG.stages.minScansToLeaveRadar && mem.totalScans>=2){
        // promotie mogelijk
        if(cons >= CFG.stages.buildUpConsistency && tscore>=2){
          if(engine==="EXPLOSIE" && (volAcc!=null && volAcc >= CFG.stages.buildUpVolAccMin)) want="BUILDUP";
          if(engine==="ACCUMULATIE" && (flat!=null && flat <= CFG.stages.flatMaxAccu)) want="BUILDUP";
        }
      }
    } else if(want==="BUILDUP"){
      mem.scansInStage = (mem.scansInStage||0)+1;
      if(tscore>=2){
        if(engine==="EXPLOSIE" && flat!=null && flat<=CFG.stages.flatMaxExpl && (volAcc!=null && volAcc>=CFG.stages.buildUpVolAccMin)) want="ALMOST";
        if(engine==="ACCUMULATIE" && flat!=null && flat<=CFG.stages.flatMaxAccu) want="ALMOST";
      }
    } else if(want==="ALMOST"){
      mem.scansInStage = (mem.scansInStage||0)+1;

      // basis entry gate
      const entryBase = (c.vol >= CFG.stages.entryMinVol) && (c.vm >= CFG.stages.entryMinVm) && (mem.totalScans >= CFG.stages.minTotalScansForEntry) && (tscore>=3);

      if(entryBase){
        // portfolio gate
        const pg = await portfolioGate(engine);
        if(pg.ok){
          // orderbook zscore gate
          try{
            const ob = await fetchBitgetOrderbook(c.bitgetSymbol, 50);
            const x = calcObScore(ob);
            if(x?.obScore==null) throw new Error("obScore null");

            mem.obHist = Array.isArray(mem.obHist) ? mem.obHist : [];
            mem.obHist.push(x.obScore);
            if(mem.obHist.length > CFG.orderbook.historyN) mem.obHist = mem.obHist.slice(-CFG.orderbook.historyN);

            const z = zScoreFromHist(mem.obHist, x.obScore);

            const passZ = (mode==="bull") ? (z!=null && z >= CFG.orderbook.zBull) : (z!=null && z <= CFG.orderbook.zBear);

            if(passZ){
              want = "ENTRY";
            } // anders blijft ALMOST
          }catch(e){
            // OB faalt -> blijft ALMOST (geen "OB ERR" spam in UI)
          }
        }
      }
    } else if(want==="ENTRY"){
      // blijft ENTRY; exit/hold/sell doen we via UI signaal (later uitbreiden)
      mem.scansInStage = (mem.scansInStage||0)+1;
    }

    // max 1 stap per scan
    const nextStage = oneStepTransition(mem, want);
    if(nextStage !== mem.stage){
      mem.stage = nextStage;
      mem.scansInStage = 1;
    }

    await saveMem(mode, c.symbol, mem);

    const out = {
      symbol: c.symbol,
      bitgetSymbol: c.bitgetSymbol,
      price: c.price,
      vol: c.vol,
      vm: c.vm,
      ch24: c.ch24,
      timingScore: tscore,
      engine,
      stage: mem.stage,
      totalScans: mem.totalScans
    };

    if(mem.stage==="RADAR") funnel.radar.push(out);
    if(mem.stage==="BUILDUP") funnel.buildup.push(out);
    if(mem.stage==="ALMOST") funnel.almost.push(out);
    if(mem.stage==="ENTRY") funnel.entry.push(out);
  }

  // sort per stage: beste boven
  const sortFn = (a,b)=> (b.timingScore-a.timingScore) || (b.vm-a.vm) || (b.vol-a.vol);
  funnel.radar.sort(sortFn);
  funnel.buildup.sort(sortFn);
  funnel.almost.sort(sortFn);
  funnel.entry.sort(sortFn);

  const result = {
    ts: Date.now(),
    mode,
    hedgeMode: CFG.hedgeMode,
    poolSize: candidates.length,
    bands,
    funnel
  };

  await kv.set(`latest:${mode}`, result);
  return result;
}

export default async function handler(req, res){
  try{
    const mode = wantMode(req);
    const result = await scanOne(mode);
    return json(res, 200, result);
  }catch(e){
    return json(res, 500, { error: String(e?.message || e) });
  }
}
