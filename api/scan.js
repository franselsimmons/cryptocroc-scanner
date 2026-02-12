import {
  config,
  fetchCoinGeckoMarket,
  getBitgetSymbolsUSDT,
  poolFilter,
  timingScore,
  loadMem,
  saveMem,
  calcDerived,
  fetchOrderbookBitget,
  zScoreFromHist,
  obGate,
  obStatusFromScore,
  riskGateDummy,
  stageLogic,
  makeSnapshot
} from "./_core.js";

export { config };

export default async function handler(req, res){
  try{
    const side = (req.query.side || "bull").toLowerCase();
    if (side !== "bull" && side !== "bear") {
      res.status(400).json({ ok:false, error:"side moet bull of bear zijn" });
      return;
    }

    // 1) Data ophalen
    const [cg, bitgetSet] = await Promise.all([
      fetchCoinGeckoMarket(),
      getBitgetSymbolsUSDT()
    ]);

    // 2) Poolfilter + bitget-only gate
    const pool = [];
    for (const c of cg){
      const sym = (c.symbol || "").toUpperCase();
      const symbolUSDT = `${sym}USDT`;
      if (!bitgetSet.has(symbolUSDT)) continue; // ✅ alleen Bitget coins

      const pf = poolFilter(c);
      if (!pf.ok) continue;

      pool.push({
        id: c.id,
        symbol: sym,
        symbolUSDT,
        price: c.current_price ?? 0,
        ch24: c.price_change_percentage_24h ?? 0,
        vol: pf.vol,
        mcap: pf.mcap,
        vm: pf.vm,
        high: c.high_24h ?? null,
        low: c.low_24h ?? null
      });
    }

    // 3) Dynamische bands
    const chArr = pool.map(x=>x.ch24);
    const lowBand = (chArr.length ? percentile(chArr, 0.10) : -999);
    const highBand = (chArr.length ? percentile(chArr, 0.90) : 999);

    // 4) Side select
    const picked = [];
    for (const c of pool){
      const passSide = (side === "bull") ? (c.ch24 >= highBand) : (c.ch24 <= lowBand);
      if (!passSide) continue;
      picked.push({ ...c, passSide });
    }

    // 5) Funnel + memory
    const out = [];
    for (const c of picked){
      const mem = await loadMem(side, c.symbol);

      const t = timingScore(side, c, c.vm);
      const snap = {
        ts: Date.now(),
        price: c.price,
        vol: c.vol,
        vm: c.vm,
        ch24: c.ch24,
        passSide: c.passSide,
        timingScore: t.score
      };

      // hist update
      mem.hist.push({ ts: snap.ts, price: snap.price, vol: snap.vol, vm: snap.vm, passSide: snap.passSide });
      if (mem.hist.length > 30) mem.hist = mem.hist.slice(-30);

      mem.totalScans += 1;

      const d = calcDerived(mem);
      snap.consistency = d.consistency;
      snap.volAcc = d.volAcc;
      snap.flat = d.flat;

      // stage move
      const proposed = stageLogic(side, mem, snap);

      // OB gate only when ALMOST -> ENTRY
      let stage = proposed;
      let obScore = null, z = null, spreadPct = null, obErr = null, obStatus = null;

      if (proposed === "ENTRY"){
        // risk gate (placeholder ok)
        const risk = riskGateDummy();
        if (!risk.ok){
          stage = "ALMOST";
        } else {
          try{
            const ob = await fetchOrderbookBitget(c.symbolUSDT);
            obScore = Number(ob.obScore.toFixed(4));
            spreadPct = ob.spreadPct == null ? null : Number(ob.spreadPct.toFixed(4));

            // update obHist
            mem.obHist.push(obScore);
            if (mem.obHist.length > 50) mem.obHist = mem.obHist.slice(-50);

            z = Number(zScoreFromHist(mem.obHist, obScore).toFixed(3));
            const okGate = obGate(side, z);
            if (!okGate){
              stage = "ALMOST";
            }
            obStatus = obStatusFromScore(side, obScore, spreadPct);
          } catch(e){
            obErr = String(e.message || e);
            stage = "ALMOST";
          }
        }
      }

      // stageScans
      if (stage !== mem.stage){
        mem.stage = stage;
        mem.stageScans = 1;
      } else {
        mem.stageScans = (mem.stageScans || 0) + 1;
      }

      await saveMem(mem);

      out.push({
        symbol: c.symbol,
        symbolUSDT: c.symbolUSDT,
        stage,
        obStatus,
        obScore,
        zScore: z,
        spreadPct,
        obErr,
        price: c.price,
        ch24: c.ch24,
        vol: c.vol,
        vm: c.vm,
        timingScore: t.score,
        totalScans: mem.totalScans,
        consistency: Number((snap.consistency||0).toFixed(3)),
        volAcc: Number((snap.volAcc||0).toFixed(3)),
        flat: snap.flat == null ? null : Number(snap.flat.toFixed(3))
      });
    }

    // 6) Snapshot opslaan voor UI + cron
    const snapshot = makeSnapshot(Date.now(), lowBand, highBand, out);
    await kv.set(`latest:${side}`, snapshot);

    res.status(200).json({ ok:true, snapshot });

  } catch(e){
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
}

function percentile(arr, p){
  const s = [...arr].sort((a,b)=>a-b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo] ?? 0;
  const w = idx - lo;
  return s[lo]*(1-w) + s[hi]*w;
}
