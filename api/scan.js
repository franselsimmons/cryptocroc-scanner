import { kv } from "@vercel/kv";
import {
  CFG, json, now,
  getBitgetUsdtSet,
  fetchCoinGeckoMarkets, mapCoin, poolPass,
  computeSideBands, sideFor,
  loadMem, saveMem, computeDerived, timingScore, enginePick, stageAdvance,
  loadRisk, updateRiskFromSignals, riskGate
} from "./_core.js";

export default async function handler(req){
  try{
    const url = new URL(req.url);
    const side = (url.searchParams.get("side") || "bull").toLowerCase();
    if(side!=="bull" && side!=="bear") return json({ ok:false, error:"side must be bull|bear" }, 400);

    // 1) Fetch + map
    const markets = await fetchCoinGeckoMarkets();
    const mapped = markets.map(mapCoin);

    // 2) Pool filter
    const pool = mapped.filter(poolPass);

    // 3) Bands on pool
    const bands = computeSideBands(pool.map(x=>x.ch24));
    const lowBand = bands.lowBand;
    const highBand = bands.highBand;

    // 4) Bitget-only set
    const usdtSet = await getBitgetUsdtSet();

    // 5) Build list for this side (and only if Bitget has SYMBOLUSDT)
    const picked = [];
    for(const c0 of pool){
      const s = sideFor(c0, {lowBand,highBand});
      if(s !== side) continue;

      const bitgetSym = (c0.symbol || "").toUpperCase() + "USDT";
      if(!usdtSet.has(bitgetSym)) continue;

      picked.push(c0);
      if(picked.length >= 60) break; // hard cap for speed
    }

    // 6) Memory update + stage machine
    const bySymbol = {};
    const out = [];
    for(const c0 of picked){
      const sym = c0.symbol;
      const mem = await loadMem(side, sym);

      mem.totalScans = (mem.totalScans || 0) + 1;
      mem.scansInStage = (mem.scansInStage || 0) + 1;

      const passSide = true; // we already filtered by side
      mem.hist = (mem.hist || []).concat([{
        ts: now(),
        price: c0.price,
        vol: c0.vol,
        vm: c0.vm,
        passSide
      }]).slice(-30);

      const d = computeDerived(mem);

      const c = {
        symbol: sym,
        price: c0.price,
        vol: c0.vol,
        mcap: c0.mcap,
        vm: c0.vm,
        ch24: c0.ch24,
        range24: c0.range24,
        ctl: c0.ctl,

        passSide,
        totalScans: mem.totalScans,

        consistency: d.consistency,
        volAcc: d.volAcc,
        flatness: d.flatness,

        engine: "EXPLOSIE", // temp, set below
        timingScore: 0,
        stage: mem.stage
      };

      c.engine = enginePick(c);
      c.timingScore = timingScore(side, c);

      // advance stage (max 1 step)
      stageAdvance(side, c, mem, d);
      c.stage = mem.stage;

      // reset scansInStage if stage changed by stageAdvance
      // (we detect by keeping stage in mem already set; if changed, scansInStage was set to 0 inside stageAdvance)
      mem.stage = c.stage;

      await saveMem(side, sym, mem);

      bySymbol[sym] = c;
      out.push(c);
    }

    // 7) Funnel buckets
    const funnel = { ENTRY:[], ALMOST:[], BUILDUP:[], RADAR:[] };
    for(const c of out){
      funnel[c.stage]?.push(c);
    }

    // sort: hoogste timing eerst
    for(const k of Object.keys(funnel)){
      funnel[k].sort((a,b)=> (b.timingScore-a.timingScore) || (b.vm-a.vm));
    }

    // 8) Risk engine (light) + hedge indicator (global)
    // We store both sides latest to compute hedge info.
    const latestBull = await kv.get("latest:bull");
    const latestBear = await kv.get("latest:bear");

    const tmpThis = { funnel };
    const risk = await updateRiskFromSignals(
      side==="bull" ? tmpThis : latestBull,
      side==="bear" ? tmpThis : latestBear
    );

    // If risk gate says no, we keep the data, but UI will show LOCK
    const gate = riskGate(side, risk);

    const data = {
      ok:true,
      ts: now(),
      side,
      items: out.length,
      lowBand, highBand,
      hedgeMode: CFG.hedgeMode,
      risk: { ...risk, gate },
      funnel,
      bySymbol
    };

    await kv.set(`latest:${side}`, data);

    return json({ ok:true, data });
  }catch(e){
    return json({ ok:false, error: e.message || String(e) }, 500);
  }
}
