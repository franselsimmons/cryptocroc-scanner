import { getJson, setJson, ensurePortfolio, KEYS } from "./_store.js";

const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));
const n = (x)=> { const v = Number(x); return Number.isFinite(v) ? v : null; };
const nowIso = ()=> new Date().toISOString();

async function fetchJson(url, tries=4){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const r = await fetch(url, { headers:{ "accept":"application/json" } });
      if(!r.ok){
        const t = await r.text().catch(()=> "");
        const e = new Error(`HTTP ${r.status} ${t.slice(0,180)}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    }catch(e){
      last = e;
      await sleep(700 + i*700);
    }
  }
  throw last;
}

function rangePct(high, low){
  const h=n(high), l=n(low);
  if(h==null || l==null || l<=0) return null;
  return ((h-l)/l)*100;
}
function vmRatio(vol, mcap){
  const v=n(vol), m=n(mcap);
  if(v==null || m==null || m<=0) return null;
  return v/m;
}
function ctlProxy(price, high, low){
  const p=n(price), h=n(high), l=n(low);
  if(p==null || h==null || l==null) return null;
  const d = h-l;
  if(d<=0) return null;
  return (p-l)/d;
}

const CFG = {
  cg: { perPage:250, pages:2, delayBetweenPagesMs:900 },
  pool: { mcapMin:3_000_000, mcapMax:400_000_000, volMin:250_000, vmMin:0.10 },
  bullBands: { ch24Min:-8,  ch24Max:15 },
  bearBands: { ch24Min:-15, ch24Max:3.5 },
  stageMin: {
    RADAR:  { volMin:250_000,  vmMin:0.10 },
    BUILDUP:{ volMin:500_000,  vmMin:0.14 },
    ALMOST: { volMin:1_000_000,vmMin:0.16 },
    ENTRY:  { volMin:1_500_000,vmMin:0.28 }
  },
  funnel: { minScansToLeaveRadar:2, minBuildUpScans:3, minTotalScansForEntry:5, promoteOneStep:true, demoteOneStep:true },
  engines: {
    EXPLOSIE: { buildUpVolAccMin:0.20, entryVolAccMin:0.30, priceFlatMax:4.0 },
    ACCUMULATIE:{ priceFlatMax:3.0 }
  }
};

const STAGES = ["RADAR","BUILDUP","ALMOST","ENTRY"];
const stageIndex = (s)=> Math.max(0, STAGES.indexOf(s||"RADAR"));
function moveOneStep(cur, des){
  const ci=stageIndex(cur), di=stageIndex(des);
  if(di>ci) return STAGES[ci+1]||cur;
  if(di<ci) return STAGES[Math.max(0,ci-1)]||cur;
  return cur;
}
function inBand(x, band){ return (x!=null) && x>=band.ch24Min && x<=band.ch24Max; }
function decideSide(ch24){
  const bullOk = inBand(ch24, CFG.bullBands);
  const bearOk = inBand(ch24, CFG.bearBands);
  if(bullOk && !bearOk) return "BULL";
  if(!bullOk && bearOk) return "BEAR";
  if(bullOk && bearOk) return (ch24>=0) ? "BULL" : "BEAR";
  return null;
}
function passPool(c){
  return c.mcap>=CFG.pool.mcapMin && c.mcap<=CFG.pool.mcapMax && c.vol>=CFG.pool.volMin && c.vm>=CFG.pool.vmMin;
}
function passStageMin(c, stage){
  const t = CFG.stageMin[stage];
  return !!t && c.vol>=t.volMin && c.vm>=t.vmMin;
}

function initMem(symbol){
  return { symbol, stage:"RADAR", totalScans:0, scansInStage:0, lastSeen:null, hist:[], lastExplain:"" };
}
function normalizeMem(mem, symbol){
  if(!mem || typeof mem!=="object") mem={};
  if(!mem.symbol) mem.symbol=symbol;
  if(!mem.stage) mem.stage="RADAR";
  if(!Number.isFinite(mem.totalScans)) mem.totalScans=0;
  if(!Number.isFinite(mem.scansInStage)) mem.scansInStage=0;
  if(!Array.isArray(mem.hist)) mem.hist=[];
  if(typeof mem.lastExplain!=="string") mem.lastExplain="";
  return mem;
}
function pushHist(mem, row){
  mem.hist.push(row);
  if(mem.hist.length>12) mem.hist.shift();
}
function calcConsistency(mem){
  const last = mem.hist.slice(-6);
  if(last.length===0) return 0;
  return last.filter(x=>x.passSide===true).length / last.length;
}
function calcVolAcceleration(mem){
  const h = mem.hist.slice(-6);
  if(h.length<6) return 0;
  const a = h.slice(0,3).reduce((s,x)=>s+(x.vol||0),0)/3;
  const b = h.slice(3,6).reduce((s,x)=>s+(x.vol||0),0)/3;
  if(a<=0) return 0;
  return (b-a)/a;
}
function calcPriceFlat(mem){
  const h = mem.hist.slice(-6).map(x=>x.price).filter(v=>Number.isFinite(v));
  if(h.length<3) return null;
  const mn=Math.min(...h), mx=Math.max(...h);
  if(mn<=0) return null;
  return ((mx-mn)/mn)*100;
}

// 10/10: trade plan in %
function tradeManagementPlanPct(engine){
  if(engine==="EXPLOSIE"){
    return { stopPct:-6, beAtPct:+6, tp1Pct:+12,
      rules:[
        "Hard stop: -6% (nooit verlagen)",
        "Bij +6%: stop naar break-even",
        "Bij +12%: neem 30% winst"
      ]
    };
  }
  return { stopPct:-4, beAtPct:+4, tp1Pct:+6,
    rules:[
      "Hard stop: -4% (nooit verlagen)",
      "Bij +4%: stop naar break-even",
      "Bij +6%: neem 30% winst"
    ]
  };
}

// sizing (trade-budget = 100% per trade)
function sizingPlanPct(engine, exp){
  // A/B/C -> %
  // EXPLOSIE: A=100, B=80, C=50
  // ACCU:    A=100, B=90, C=60
  if(engine==="EXPLOSIE"){
    if(exp>=1.35) return { label:"A", suggestedSizePct:100 };
    if(exp>=1.05) return { label:"B", suggestedSizePct:80 };
    return { label:"C", suggestedSizePct:50 };
  }else{
    if(exp>=1.25) return { label:"A", suggestedSizePct:100 };
    if(exp>=1.00) return { label:"B", suggestedSizePct:90 };
    return { label:"C", suggestedSizePct:60 };
  }
}

// simpele expectancy proxy (consistent + volAcc)
function expectancyProxy(cons, volAcc){
  return (cons*1.4) + (Math.max(-0.2, Math.min(0.8, volAcc))*1.0);
}

// portfolio gate (ALLOW/SUPPRESS)
function ddPct(port){
  const peak = Number(port?.peakBalance ?? port?.currentBalance ?? 0);
  const cur  = Number(port?.currentBalance ?? 0);
  if(peak<=0) return 0;
  return ((cur-peak)/peak)*100;
}
function openCounts(port){
  const pos = Array.isArray(port?.positions) ? port.positions : [];
  const open = pos.filter(p=>p.isOpen);
  return {
    explosie: open.filter(p=>p.engine==="EXPLOSIE").length,
    accu: open.filter(p=>p.engine==="ACCUMULATIE").length,
    openRiskPct: open.reduce((s,p)=> s + (Number(p.openRiskPct)||0), 0)
  };
}

async function detectRegime(){
  const url="https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1&sparkline=false";
  const data = await fetchJson(url, 4);
  const btc = Array.isArray(data) ? data[0] : null;
  const r = rangePct(btc?.high_24h, btc?.low_24h) ?? 0;
  return { regime: (r>4.5) ? "HIGH_VOL" : "GRIND", btcRange24h:r, source:"btc_range_24h" };
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");

  // 1) portfolio init
  const port = await ensurePortfolio();

  // 2) memory load
  const memAllRaw = await getJson(KEYS.memory, {});
  const memAll = (memAllRaw && typeof memAllRaw==="object") ? memAllRaw : {};

  const started = nowIso();

  // 3) regime
  let regimeInfo;
  try{
    regimeInfo = await detectRegime();
  }catch(e){
    // als BTC call faalt: niet crashen
    regimeInfo = { regime:"GRIND", btcRange24h:null, source:"fallback" };
  }

  // 4) fetch coins (best effort)
  const all=[];
  const seen=new Set();

  try{
    for(let page=1; page<=CFG.cg.pages; page++){
      const url=
        "https://api.coingecko.com/api/v3/coins/markets" +
        `?vs_currency=usd&order=volume_desc&per_page=${CFG.cg.perPage}&page=${page}` +
        "&sparkline=false&price_change_percentage=24h";

      const data = await fetchJson(url, 4);
      if(!Array.isArray(data) || data.length===0) break;

      for(const x of data){
        if(!x?.id || seen.has(x.id)) continue;
        seen.add(x.id);

        const sym=(x.symbol||"").toUpperCase();
        const c={
          id:x.id,
          symbol:sym,
          name:x.name||sym,
          price:n(x.current_price),
          mcap:n(x.market_cap),
          vol:n(x.total_volume),
          high:n(x.high_24h),
          low:n(x.low_24h),
          ch24:n(x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h)
        };
        c.range = rangePct(c.high,c.low);
        c.vm = vmRatio(c.vol,c.mcap);
        c.ctl = ctlProxy(c.price,c.high,c.low);

        if(!sym || c.price==null || c.mcap==null || c.vol==null || c.vm==null || c.ch24==null) continue;
        if(!passPool(c)) continue;

        all.push(c);
      }

      await sleep(CFG.cg.delayBetweenPagesMs);
    }
  }catch(e){
    // CoinGecko 429? -> hou oude data aan
    const prevBull = await getJson(KEYS.bull, null);
    const prevBear = await getJson(KEYS.bear, null);
    return res.status(200).json({
      ok:false,
      ts:started,
      error:String(e.message||e),
      note:"CoinGecko rate-limit of error. Oude output blijft staan.",
      prevAvailable: { bull:!!prevBull, bear:!!prevBear }
    });
  }

  const bull={ entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };
  const bear={ entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };

  for(const c of all){
    const side = decideSide(c.ch24);
    if(!side) continue;

    const key = `${side}:${c.symbol}`;
    const mem = normalizeMem(memAll[key] || initMem(c.symbol), c.symbol);

    const passSide = passStageMin(c,"RADAR") && inBand(c.ch24, side==="BULL"?CFG.bullBands:CFG.bearBands);

    mem.totalScans += 1;
    mem.lastSeen = started;
    pushHist(mem, { ts:started, price:c.price, vol:c.vol, vm:c.vm, passSide });

    const cons=calcConsistency(mem);
    const volAcc=calcVolAcceleration(mem);
    const flat=calcPriceFlat(mem);

    const engine = (regimeInfo.regime==="HIGH_VOL")
      ? (volAcc>=0.20 ? "EXPLOSIE" : "ACCUMULATIE")
      : (flat!=null && flat<=3.5 ? "ACCUMULATIE" : "EXPLOSIE");

    // nieuwe coin -> RADAR direct zichtbaar
    if(mem.totalScans===1){
      mem.stage="RADAR";
      mem.scansInStage=1;
      mem.lastExplain="Nieuw gezien → RADAR lock.";

      const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
        side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
        finalStage:"RADAR", scansInStage:1, totalScans:1,
        consistency:cons, volAcceleration:volAcc, priceFlatPct:flat,
        ob:null, risk:null, tradePlan:null, explain:mem.lastExplain
      };
      (side==="BULL"?bull.radar:bear.radar).push(row);
      memAll[key]=mem;
      continue;
    }

    if(!passSide){
      const curI=stageIndex(mem.stage);
      mem.stage = CFG.funnel.demoteOneStep ? STAGES[Math.max(0,curI-1)] : "RADAR";
      mem.scansInStage=1;
      mem.lastExplain="Faalt basis → 1 stap terug.";
      memAll[key]=mem;
      continue;
    }

    if(mem.stage==="RADAR" && mem.totalScans < CFG.funnel.minScansToLeaveRadar){
      mem.scansInStage += 1;
      mem.lastExplain=`RADAR lock: ${mem.totalScans}/${CFG.funnel.minScansToLeaveRadar}.`;
      const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
        side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
        finalStage:"RADAR", scansInStage:mem.scansInStage, totalScans:mem.totalScans,
        consistency:cons, volAcceleration:volAcc, priceFlatPct:flat,
        ob:null, risk:null, tradePlan:null, explain:mem.lastExplain
      };
      (side==="BULL"?bull.radar:bear.radar).push(row);
      memAll[key]=mem;
      continue;
    }

    // stage ladder (zonder OB online; OB kan later weer erbij)
    let desired="RADAR";
    if(passStageMin(c,"BUILDUP") && cons>=0.82) desired="BUILDUP";
    if(desired==="BUILDUP" && passStageMin(c,"ALMOST")) desired="ALMOST";
    if(desired==="ALMOST" && passStageMin(c,"ENTRY") && mem.totalScans>=CFG.funnel.minTotalScansForEntry) desired="ENTRY";

    const nextStage = CFG.funnel.promoteOneStep ? moveOneStep(mem.stage, desired) : desired;
    if(nextStage===mem.stage) mem.scansInStage += 1;
    else { mem.stage=nextStage; mem.scansInStage=1; }

    const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
      side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
      finalStage:mem.stage, scansInStage:mem.scansInStage, totalScans:mem.totalScans,
      consistency:cons, volAcceleration:volAcc, priceFlatPct:flat,
      ob:null, risk:null, tradePlan:null, explain:`OK: engine=${engine}, cons=${Math.round(cons*100)}%, volAcc=${Math.round(volAcc*100)}%`
    };

    // ENTRY = portfolio gate + % sizing + % plan
    if(row.finalStage==="ENTRY"){
      const exp = expectancyProxy(cons, volAcc);
      const sp  = sizingPlanPct(engine, exp);
      const plan= tradeManagementPlanPct(engine);

      let gate="ALLOW", gateReason="OK";
      const dd = ddPct(port);
      const counts = openCounts(port);
      const maxDD = Number(port.maxDrawdownPct ?? -8);
      if(dd <= maxDD){ gate="SUPPRESS"; gateReason=`DD kill switch (${dd.toFixed(2)}% <= ${maxDD}%)`; }

      const addOpenRisk = (Number(sp.suggestedSizePct) * Math.abs(Number(plan.stopPct))) / 100;
      const maxTotal = Number(port.maxTotalOpenRiskPct ?? 4);
      if(gate==="ALLOW" && (counts.openRiskPct + addOpenRisk) > maxTotal){
        gate="SUPPRESS"; gateReason=`Max open risk (${(counts.openRiskPct+addOpenRisk).toFixed(2)}% > ${maxTotal}%)`;
      }
      if(gate==="ALLOW" && engine==="EXPLOSIE" && counts.explosie >= Number(port.maxOpenExplosie ?? 2)){
        gate="SUPPRESS"; gateReason="Max EXPLOSIE trades bereikt";
      }
      if(gate==="ALLOW" && engine==="ACCUMULATIE" && counts.accu >= Number(port.maxOpenAccu ?? 3)){
        gate="SUPPRESS"; gateReason="Max ACCUMULATIE trades bereikt";
      }

      row.risk = { sizingLabel:sp.label, suggestedSizePct:sp.suggestedSizePct, gate, gateReason };
      row.tradePlan = plan;
    }

    memAll[key]=mem;

    const bucket = (side==="BULL") ? bull : bear;
    if(row.finalStage==="RADAR") bucket.radar.push(row);
    else if(row.finalStage==="BUILDUP") bucket.buildup.push(row);
    else if(row.finalStage==="ALMOST") bucket.almost.push(row);
    else if(row.finalStage==="ENTRY") bucket.entry_entry.push(row);
  }

  const meta={
    ts: started,
    pulled: { coinsAfterPool: all.length, cgPages: CFG.cg.pages, cgPerPage: CFG.cg.perPage },
    regime: regimeInfo,
    notes:{ online:"Vercel cron -> /api/scan" }
  };

  const bullOut = { side:"BULL", ...meta, tables: bull };
  const bearOut = { side:"BEAR", ...meta, tables: bear };

  await setJson(KEYS.bull, bullOut);
  await setJson(KEYS.bear, bearOut);
  await setJson(KEYS.memory, memAll);

  return res.status(200).json({ ok:true, ts:started, poolCoins:all.length, regime:regimeInfo.regime });
}
