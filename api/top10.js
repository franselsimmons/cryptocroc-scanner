import { kv } from "@vercel/kv";
export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;

// ================== CONFIG (filters) ==================
const CFG = {
  pool: { mcapMin: 3_000_000, mcapMax: 400_000_000, volMin: 250_000, vmMin: 0.10 },
  bands: { lowPct: 0.10, highPct: 0.90 },
  memory: { maxScans: 30 },
  stage: {
    minScansToLeaveRadar: 2,
    minTotalScansForEntry: 5,
    buildUpConsistency: 0.82
  },
  entryBase: { volMin: 1_500_000, vmMin: 0.28 },
  timing: { rangeMin: 4.2, rangeMax: 25, bullCtl: 0.70, bearCtl: 0.30, vmMin: 0.14 },
  orderbook: { depthPct: 2, maxCallsPerScan: 10, zBull: 1.0, zBear: -1.0, holdBull: 0.18, sellBull: -0.10, holdBear: -0.18, sellBear: 0.10, spreadHold: 0.28, spreadSell: 0.35 },
  risk: { maxDrawdownPct: -8, maxTotalOpenRiskPct: 4, maxOpenExplosie: 2, maxOpenAccu: 3 },
  hedge: { enabled: true }
};

// ================== helpers ==================
function json(res, code, obj){
  res.setHeader("Content-Type","application/json");
  res.setHeader("Cache-Control","no-store");
  res.status(code).end(JSON.stringify(obj));
}
function pct(a,b){ return b ? ((a-b)/b)*100 : 0; }
function clamp(x,a,b){ return Math.max(a, Math.min(b,x)); }
function mean(arr){ return arr.reduce((a,b)=>a+b,0)/(arr.length||1); }
function std(arr){
  const m = mean(arr);
  const v = mean(arr.map(x => (x-m)*(x-m)));
  return Math.sqrt(v);
}
function quantile(sorted, q){
  if(!sorted.length) return 0;
  const i = Math.floor(sorted.length * q);
  return sorted[clamp(i,0,sorted.length-1)];
}

function timingScore(side, c){
  let s=0;
  if(side==="BULL" && c.ch24>0) s++;
  if(side==="BEAR" && c.ch24<0) s++;
  if(c.vm>=CFG.timing.vmMin) s++;
  if(c.range>=CFG.timing.rangeMin && c.range<=CFG.timing.rangeMax) s++;
  if(side==="BULL" && c.ctl>=CFG.timing.bullCtl) s++;
  if(side==="BEAR" && c.ctl<=CFG.timing.bearCtl) s++;
  return s;
}

function computeStats(hist){
  const last6 = hist.slice(-6);
  const passCount = last6.filter(x=>x.passSide).length;
  const consistency = last6.length ? passCount/last6.length : 0;

  const prices = last6.map(x=>x.price);
  const flatness = prices.length ? (Math.max(...prices)-Math.min(...prices)) / (Math.min(...prices)||1) : null;

  const v = last6.map(x=>x.vol);
  const first3 = v.slice(0,3);
  const last3 = v.slice(-3);
  const avgA = first3.length ? mean(first3) : 0;
  const avgB = last3.length ? mean(last3) : 0;
  const volAcc = avgA ? (avgB-avgA)/avgA : 0;

  return { consistency, flatness, volAcc };
}

async function getPortfolio(){
  return (await kv.get("portfolio:state")) || { equity:1000, drawdownPct:0, openPositions:[] };
}

function riskGate(portfolio, candidate){
  // kill switch
  if(Number(portfolio.drawdownPct) <= CFG.risk.maxDrawdownPct){
    return { ok:false, reason:`KillSwitch: drawdown ${portfolio.drawdownPct}%` };
  }

  const open = Array.isArray(portfolio.openPositions) ? portfolio.openPositions : [];
  const totalRisk = open.reduce((s,p)=> s + Number(p.riskPct||0), 0);
  if(totalRisk >= CFG.risk.maxTotalOpenRiskPct){
    return { ok:false, reason:`Max total open risk ${totalRisk}%` };
  }

  // engine buckets (simpel)
  const explosie = open.filter(p=>p.engine==="EXPLOSIE").length;
  const accu = open.filter(p=>p.engine==="ACCUMULATIE").length;

  if(candidate.engine==="EXPLOSIE" && explosie >= CFG.risk.maxOpenExplosie) return { ok:false, reason:"Max open EXPLOSIE reached" };
  if(candidate.engine==="ACCUMULATIE" && accu >= CFG.risk.maxOpenAccu) return { ok:false, reason:"Max open ACCU reached" };

  return { ok:true };
}

async function obGate(symbol, mid, side){
  const HKEY = `ob:hist:${symbol}`;
  // we call our own orderbook endpoint logic inline (zonder HTTP) -> sneller
  // maar we gebruiken dezelfde berekening: we doen HTTP call omdat Bitget fetch daar zit.
  const depthPct = CFG.orderbook.depthPct;
  const url = `https://${process.env.VERCEL_URL || "example.com"}/api/orderbook?symbol=${encodeURIComponent(symbol)}&mid=${encodeURIComponent(mid)}&depthPct=${encodeURIComponent(depthPct)}`;

  // In Vercel werkt dit alleen goed met absolute URL; lokaal kan het anders.
  // Daarom fallback: direct Bitget via orderbook endpoint is te lang hier, dus we gebruiken fetch naar eigen route.
  // Als VERCEL_URL niet bestaat (preview), maken we relative fallback.
  let r;
  if(process.env.VERCEL_URL){
    r = await fetchFn(url, { cache:"no-store" });
  }else{
    r = await fetchFn(`/api/orderbook?symbol=${encodeURIComponent(symbol)}&mid=${encodeURIComponent(mid)}&depthPct=${encodeURIComponent(depthPct)}`, { cache:"no-store" });
  }
  const j = await r.json();
  if(!j.ok) return { ok:false, reason:j.error || "OB failed" };

  const z = Number(j.zScore);
  const spread = Number(j.spreadPct);

  if(side==="BULL" && z < CFG.orderbook.zBull) return { ok:false, reason:`OB zScore ${z.toFixed(2)} < ${CFG.orderbook.zBull}` };
  if(side==="BEAR" && z > CFG.orderbook.zBear) return { ok:false, reason:`OB zScore ${z.toFixed(2)} > ${CFG.orderbook.zBear}` };

  // HOLD/SELL signal helpers
  let signal = "ENTRY";
  if(side==="BULL"){
    if(j.obScore >= CFG.orderbook.holdBull && spread <= CFG.orderbook.spreadHold) signal="HOLD";
    if(j.obScore <= CFG.orderbook.sellBull && spread >= CFG.orderbook.spreadSell) signal="SELL";
  }else{
    if(j.obScore <= CFG.orderbook.holdBear && spread <= CFG.orderbook.spreadHold) signal="HOLD";
    if(j.obScore >= CFG.orderbook.sellBear && spread >= CFG.orderbook.spreadSell) signal="SELL";
  }

  return { ok:true, ...j, signal };
}

// ================== handler ==================
export default async function handler(req,res){
  try{
    // 1) market data
    const r = await fetchFn("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&price_change_percentage=24h",{ cache:"no-store" });
    const data = await r.json();

    // 2) pool filters
    const pool = data.map(c=>{
      const mcap = Number(c.market_cap||0);
      const vol = Number(c.total_volume||0);
      const price = Number(c.current_price||0);
      const ch24 = Number(c.price_change_percentage_24h||0);
      const vm = (mcap>0) ? vol/mcap : 0;

      const high = Number(c.high_24h || price);
      const low  = Number(c.low_24h  || price);
      const range = pct(high, low);
      const ctl = (high-low) ? (price-low)/(high-low) : 0.5;

      return {
        id: c.id,
        symbol: String(c.symbol||"").toUpperCase(),
        name: c.name,
        price,
        ch24,
        mcap,
        vol,
        vm,
        range,
        ctl
      };
    }).filter(c=>{
      return (
        c.mcap >= CFG.pool.mcapMin &&
        c.mcap <= CFG.pool.mcapMax &&
        c.vol  >= CFG.pool.volMin &&
        c.vm   >= CFG.pool.vmMin &&
        c.price > 0 &&
        c.symbol
      );
    });

    // 3) dynamic side bands
    const allCh = pool.map(x=>x.ch24).sort((a,b)=>a-b);
    const lowBand  = quantile(allCh, CFG.bands.lowPct);
    const highBand = quantile(allCh, CFG.bands.highPct);

    // 4) portfolio state
    const portfolio = await getPortfolio();

    // 5) build candidates + memory stages
    const now = Date.now();
    const memOps = [];
    const staged = [];

    for(const c of pool){
      let side = null;
      if(c.ch24 >= highBand) side="BULL";
      else if(c.ch24 <= lowBand) side="BEAR";
      else continue;

      const passSide = true; // (hier later extra side gates mogelijk)
      const key = `mem:${side}:${c.symbol}`;

      const mem = (await kv.get(key)) || { stage:"RADAR", scansInStage:0, totalScans:0, hist:[] };
      const hist = Array.isArray(mem.hist) ? mem.hist.slice(-CFG.memory.maxScans) : [];

      hist.push({ ts: now, price:c.price, vol:c.vol, vm:c.vm, passSide });

      const totalScans = (Number(mem.totalScans)||0) + 1;

      const stats = computeStats(hist);
      const tScore = timingScore(side, c);

      // engine (simpel: regime based on BTC range 24h later; nu heuristic)
      const engine = (Math.abs(c.ch24) >= 12 && stats.volAcc >= 0.20) ? "EXPLOSIE" : "ACCUMULATIE";

      // stage machine
      let stage = mem.stage || "RADAR";
      let scansInStage = Number(mem.scansInStage)||0;
      scansInStage++;

      // RADAR -> BUILDUP
      if(stage==="RADAR"){
        if(scansInStage >= CFG.stage.minScansToLeaveRadar && tScore>=2 && stats.consistency>=CFG.stage.buildUpConsistency){
          stage="BUILDUP"; scansInStage=1;
        }
      }
      // BUILDUP -> ALMOST
      else if(stage==="BUILDUP"){
        if(tScore>=2 && stats.flatness!=null){
          // explosie: iets ruimer flatness; accu strakker
          const ok = (engine==="EXPLOSIE") ? (stats.flatness <= 0.04 && stats.volAcc>=0.20) : (stats.flatness <= 0.03);
          if(ok){ stage="ALMOST"; scansInStage=1; }
        }
      }
      // ALMOST -> ENTRY (met gates)
      else if(stage==="ALMOST"){
        const baseOk = (c.vol>=CFG.entryBase.volMin && c.vm>=CFG.entryBase.vmMin);
        const scansOk = totalScans >= CFG.stage.minTotalScansForEntry;
        const timingOk = tScore>=3;

        if(baseOk && scansOk && timingOk){
          // orderbook gate (max calls)
          stage="ENTRY"; scansInStage=1;
        }
      }
      // ENTRY blijft ENTRY (exit signals via OB)
      else if(stage==="ENTRY"){
        // blijft staan; signalen komen later via OB
      }

      const item = {
        ...c,
        side,
        engine,
        timingScore: tScore,
        stage,
        scansInStage,
        totalScans,
        consistency: stats.consistency,
        volAcc: stats.volAcc,
        flatness: stats.flatness
      };

      // memory write
      memOps.push(kv.set(key, { stage, scansInStage, totalScans, hist: hist.slice(-CFG.memory.maxScans) }));

      staged.push(item);
    }

    await Promise.all(memOps);

    // 6) Orderbook calls: alleen voor ALMOST/ENTRY (max per scan)
    const needOB = staged.filter(x => x.stage==="ALMOST" || x.stage==="ENTRY");
    const picked = needOB.slice(0, CFG.orderbook.maxCallsPerScan);

    const obMap = new Map();
    for(const x of picked){
      try{
        const ob = await obGate(x.symbol + "USDT", x.price, x.side); // Bitget: meestal SYMBOLUSDT
        obMap.set(x.symbol, ob);
      }catch(e){
        obMap.set(x.symbol, { ok:false, reason:e.message });
      }
    }

    // 7) Apply OB gate + risk gate to ENTRY candidates
    const final = staged.map(x=>{
      const ob = obMap.get(x.symbol) || null;

      let entryAllowed = true;
      let gateReason = null;
      let obSignal = null;

      if(x.stage==="ENTRY"){
        // OB gate moet bestaan + slagen
        if(!ob || !ob.ok){
          entryAllowed=false;
          gateReason = ob?.reason || "Orderbook not checked";
        }else{
          obSignal = ob.signal;

          // zscore threshold already in obGate; if ok => gate passed
        }

        // risk gate
        if(entryAllowed){
          const rg = riskGate(portfolio, { symbol:x.symbol, side:x.side, engine:x.engine, riskPct:1 });
          if(!rg.ok){
            entryAllowed=false;
            gateReason = rg.reason;
          }
        }

        // Als gate faalt -> terug naar ALMOST (zodat UI logisch blijft)
        if(!entryAllowed){
          x = { ...x, stage:"ALMOST", entryDenied:true };
        }
      }

      return {
        ...x,
        ob: ob && ob.ok ? {
          obScore: ob.obScore,
          zScore: ob.zScore,
          spreadPct: ob.spreadPct,
          signal: obSignal || ob.signal
        } : (ob ? { error: ob.reason } : null),
        gate: x.stage==="ENTRY" ? { allowed:true } : (x.entryDenied ? { allowed:false, reason: gateReason } : null)
      };
    });

    // 8) Sort: ENTRY boven, RADAR onder
    const order = { "ENTRY":0, "ALMOST":1, "BUILDUP":2, "RADAR":3 };
    final.sort((a,b)=>{
      const da = order[a.stage] ?? 9;
      const db = order[b.stage] ?? 9;
      if(da!==db) return da-db;
      // tie-break: timingScore desc, vol desc
      if(b.timingScore!==a.timingScore) return b.timingScore-a.timingScore;
      return b.vol-a.vol;
    });

    // 9) Split bull/bear
    const bull = final.filter(x=>x.side==="BULL");
    const bear = final.filter(x=>x.side==="BEAR");

    // 10) Hedge suggestions (simpel)
    const hedge = [];
    if(CFG.hedge.enabled){
      const bullEntry = bull.filter(x=>x.stage==="ENTRY").slice(0,3);
      const bearEntry = bear.filter(x=>x.stage==="ENTRY").slice(0,3);
      for(const b1 of bullEntry){
        for(const b2 of bearEntry){
          hedge.push({ long: b1.symbol, short: b2.symbol, note:"Hedge pair (basic)" });
        }
      }
    }

    return json(res, 200, {
      ok:true,
      updated: now,
      bands: { lowBand, highBand },
      portfolio,
      hedge,
      bull,
      bear
    });

  }catch(e){
    return json(res, 500, { ok:false, error:e.message });
  }
}
