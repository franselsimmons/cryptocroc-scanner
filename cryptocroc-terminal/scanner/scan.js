import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUT_DIR = path.join(__dirname, "..", "output");
const BULL_OUT = path.join(OUT_DIR, "bull.json");
const BEAR_OUT = path.join(OUT_DIR, "bear.json");
const MEM_OUT  = path.join(OUT_DIR, "memory.json");
const BITGET_SYMBOLS_CACHE = path.join(OUT_DIR, "bitget_symbols_usdt_spot.json");

fs.mkdirSync(OUT_DIR, { recursive: true });

const nowIso = () => new Date().toISOString();
const sleep = (ms)=> new Promise(r=>setTimeout(r,ms));

function readJsonSafe(p, fallback) { try { return JSON.parse(fs.readFileSync(p,"utf8")); } catch { return fallback; } }
function writeJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj,null,2)); }

async function fetchJson(url, tries = 4){
  let last;
  for(let i=0;i<tries;i++){
    try{
      const r = await fetch(url, { headers: { "accept":"application/json" } });
      if(!r.ok){
        const t = await r.text().catch(()=> "");
        const e = new Error(`HTTP ${r.status} ${t.slice(0,180)}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    }catch(e){
      last = e;
      await sleep(650 + i*500);
    }
  }
  throw last;
}

const n = (x)=> { const v = Number(x); return Number.isFinite(v) ? v : null; };

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
  // ✅ 500 coins: 2 pagina’s × 250
  cg: { vs:"usd", order:"volume_desc", perPage:250, pages:2, delayBetweenPagesMs:900 },

  // ✅ POOL (basisselectie)
  pool: { mcapMin:3_000_000, mcapMax:400_000_000, volMin:250_000, vmMin:0.10 },

  // ✅ Bull/Bear bands (side op band, niet op +/− teken)
  bullBands: { ch24Min:-8,  ch24Max:15 },
  bearBands: { ch24Min:-15, ch24Max:3.5 },

  // ✅ Trechter minima per stage (RADAR breed → ENTRY streng)
  stageMin: {
    RADAR:  { volMin:250_000,  vmMin:0.10 },
    BUILDUP:{ volMin:500_000,  vmMin:0.14 },
    ALMOST: { volMin:1_000_000,vmMin:0.16 },
    ENTRY:  { volMin:1_500_000,vmMin:0.28 },
  },

  funnel: {
    minScansToLeaveRadar: 2,     // RADAR lock
    minBuildUpScans: 3,          // buildup bevestigen
    minTotalScansForEntry: 5,    // entry pas later
    promoteOneStep: true,
    demoteOneStep: true,
  },

  // ✅ 2 engines + regime
  engines: {
    EXPLOSIE: {
      buildUpVolAccMin: 0.20,
      entryVolAccMin:   0.30,
      priceFlatMax:     4.0,
      entryObMinBull:   0.12,
      entryObMinBear:  -0.12
    },
    ACCUMULATIE: {
      priceFlatMax:     3.0,
      buildUpVolAccMin: 0.10,
      entryObMinBull:   0.00,
      entryObMinBear:   0.00
    }
  },

  ob: {
    depthLimit: 20,
    depthPct: 0.02,
    sellSpreadPct: 0.35,
    holdSpreadPct: 0.28,
    bullHoldScore: 0.18,
    bullSellScore: -0.10,
    bearHoldScore: -0.18,
    bearSellScore: 0.10
  },

  risk: { maxOpenExplosie:2, maxOpenAccu:3, maxTotalRiskPct:4, ddKillSwitchPct:-8 }
};

// ---------------- BITGET (symbols + orderbook) ----------------
// LET OP: als Bitget dit ooit weer aanpast, dan faalt OB netjes (n/a) maar je scan blijft draaien.
async function loadBitgetUsdtSpotSymbols(){
  try{
    if(fs.existsSync(BITGET_SYMBOLS_CACHE)){
      const cached = readJsonSafe(BITGET_SYMBOLS_CACHE, null);
      if(cached?.ts && (Date.now()-cached.ts) < 24*60*60*1000 && cached.map){
        return cached.map;
      }
    }
  }catch{}

  // fallback: probeer meerdere endpoints (we willen niet “hard crashen”)
  const urls = [
    "https://api.bitget.com/api/v3/market/instruments?category=SPOT",
    "https://api.bitget.com/api/v2/spot/public/symbols"
  ];

  let map = {};
  let ok = false;

  for(const url of urls){
    try{
      const j = await fetchJson(url, 3);
      const list = j?.data || [];
      // v3: baseCoin/quoteCoin/symbol/status
      if(list.length && (list[0]?.baseCoin || list[0]?.quoteCoin)){
        for(const it of list){
          const base = (it?.baseCoin || "").toString().toUpperCase();
          const quote = (it?.quoteCoin || "").toString().toUpperCase();
          const sym = (it?.symbol || "").toString().toUpperCase();
          const status = (it?.status || "").toString().toLowerCase();
          if(!base || quote!=="USDT" || !sym) continue;
          if(status && status !== "online") continue;
          map[base] = sym;
        }
        ok = true;
        break;
      }
      // v2: symbolName/baseCoin/quoteCoin
      if(list.length && (list[0]?.symbolName || list[0]?.baseCoin)){
        for(const it of list){
          const base = (it?.baseCoin || "").toString().toUpperCase();
          const quote = (it?.quoteCoin || "").toString().toUpperCase();
          const sym = (it?.symbolName || it?.symbol || "").toString().toUpperCase().replace("_","");
          if(!base || quote!=="USDT" || !sym) continue;
          map[base] = sym;
        }
        ok = true;
        break;
      }
    }catch{}
  }

  writeJson(BITGET_SYMBOLS_CACHE, { ts: Date.now(), ok, mapCount: Object.keys(map).length, map });
  return map;
}

async function fetchBitgetOrderbookSpot(symbol, limit=20){
  // probeer v3, dan v2
  const urls = [
    `https://api.bitget.com/api/v3/market/orderbook?category=SPOT&symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
    `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbol)}&limit=${limit}`
  ];

  for(const url of urls){
    try{
      const j = await fetchJson(url, 2);
      const d = j?.data || {};
      // v3: bids=b, asks=a
      if(d?.b || d?.a) return { bids: d?.b || [], asks: d?.a || [] };
      // v2: bids/asks
      if(d?.bids || d?.asks) return { bids: d?.bids || [], asks: d?.asks || [] };
    }catch{}
  }
  throw new Error("orderbook_failed");
}

function calcObMetrics(ob, midPrice, depthPct=0.02){
  const mid = n(midPrice);
  if(mid==null || mid<=0) return null;

  const minBid = mid*(1-depthPct);
  const maxAsk = mid*(1+depthPct);

  let bidUsd=0, askUsd=0;

  for(const b of ob.bids || []){
    const p=n(b[0]), sz=n(b[1]);
    if(p==null || sz==null) continue;
    if(p>=minBid && p<=mid) bidUsd += p*sz;
  }
  for(const a of ob.asks || []){
    const p=n(a[0]), sz=n(a[1]);
    if(p==null || sz==null) continue;
    if(p<=maxAsk && p>=mid) askUsd += p*sz;
  }

  const score = (bidUsd+askUsd)>0 ? (bidUsd-askUsd)/(bidUsd+askUsd) : 0;

  const bestBid = ob.bids?.[0]?.[0] ? n(ob.bids[0][0]) : null;
  const bestAsk = ob.asks?.[0]?.[0] ? n(ob.asks[0][0]) : null;
  const spreadPct = (bestBid && bestAsk && bestAsk>0)
    ? ((bestAsk-bestBid)/((bestAsk+bestBid)/2))*100
    : null;

  return { bidUsd, askUsd, score, spreadPct };
}

// ---------------- MEMORY (normalize) ----------------
function initMem(symbol){
  return { symbol, stage:"RADAR", totalScans:0, scansInStage:0, lastSeen:null, hist:[], lastExplain:"" };
}
function normalizeMem(mem, symbol){
  if(!mem || typeof mem !== "object") mem = {};
  if(!mem.symbol) mem.symbol = symbol;
  if(!mem.stage) mem.stage = "RADAR";
  if(!Number.isFinite(mem.totalScans)) mem.totalScans = 0;
  if(!Number.isFinite(mem.scansInStage)) mem.scansInStage = 0;
  if(!Array.isArray(mem.hist)) mem.hist = [];
  if(typeof mem.lastExplain !== "string") mem.lastExplain = "";
  return mem;
}
function pushHist(mem, row){
  mem.hist.push(row);
  if(mem.hist.length>12) mem.hist.shift();
}
function calcConsistency(mem){
  const last = mem.hist.slice(-6);
  if(last.length===0) return 0;
  const ok = last.filter(x=>x.passSide===true).length;
  return ok/last.length;
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
  const mn = Math.min(...h);
  const mx = Math.max(...h);
  if(mn<=0) return null;
  return ((mx-mn)/mn)*100;
}

const STAGES = ["RADAR","BUILDUP","ALMOST","ENTRY"];
const stageIndex = (s)=> Math.max(0, STAGES.indexOf(s||"RADAR"));
function moveOneStep(cur, des){
  const ci = stageIndex(cur), di = stageIndex(des);
  if(di>ci) return STAGES[ci+1] || cur;
  if(di<ci) return STAGES[Math.max(0,ci-1)] || cur;
  return cur;
}

// ---------------- REGIME (BTC range) ----------------
async function detectRegime(){
  const url="https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1&sparkline=false";
  const data = await fetchJson(url, 4);
  const btc = Array.isArray(data) ? data[0] : null;
  const r = rangePct(btc?.high_24h, btc?.low_24h);
  const btcRange24h = r==null ? 0 : r;
  return { regime: (btcRange24h>4.5) ? "HIGH_VOL" : "GRIND", btcRange24h, source:"btc_range_24h" };
}
function pickEngine(regime, volAcc, flat){
  if(regime==="HIGH_VOL") return (volAcc>=0.20) ? "EXPLOSIE" : "ACCUMULATIE";
  return (flat!=null && flat<=3.5) ? "ACCUMULATIE" : "EXPLOSIE";
}

// ---------------- SIDE (bands) ----------------
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

// timing proxy (simpel maar bruikbaar)
function timingScoreBull(c){
  let s=0;
  if(c.ch24>0) s++;
  if(c.vm>=CFG.stageMin.BUILDUP.vmMin) s++;
  if(c.range!=null && c.range>=4.2 && c.range<=25) s++;
  if(c.ctl!=null && c.ctl>=0.70) s++;
  return s;
}
function timingScoreBear(c){
  let s=0;
  if(c.ch24<0) s++;
  if(c.vm>=CFG.stageMin.BUILDUP.vmMin) s++;
  if(c.range!=null && c.range>=4.2 && c.range<=25) s++;
  if(c.ctl!=null && c.ctl<=0.30) s++;
  return s;
}

function obPassForEntry(side, engine, obScore){
  if(obScore==null || !Number.isFinite(obScore)) return false;
  if(engine==="EXPLOSIE"){
    return (side==="BULL") ? (obScore >= CFG.engines.EXPLOSIE.entryObMinBull)
                           : (obScore <= CFG.engines.EXPLOSIE.entryObMinBear);
  }
  return (side==="BULL") ? (obScore >= CFG.engines.ACCUMULATIE.entryObMinBull)
                         : (obScore <= CFG.engines.ACCUMULATIE.entryObMinBear);
}

// ENTRY/HOLD/SELL label (UI)
function entryState(side, row){
  const ob=row.ob, spread=ob?.spreadPct;
  if(!ob || spread==null) return "ENTRY";
  if(side==="BULL"){
    if(ob.score<=CFG.ob.bullSellScore && spread>=CFG.ob.sellSpreadPct) return "SELL";
    if(ob.score>=CFG.ob.bullHoldScore && spread<=CFG.ob.holdSpreadPct) return "HOLD";
    return "ENTRY";
  }else{
    if(ob.score>=CFG.ob.bearSellScore && spread>=CFG.ob.sellSpreadPct) return "SELL";
    if(ob.score<=CFG.ob.bearHoldScore && spread<=CFG.ob.holdSpreadPct) return "HOLD";
    return "ENTRY";
  }
}

// sizing + plan (popup)
function expectancyProxy(row){
  const cons=row.consistency??0, va=row.volAcceleration??0, ob=row.ob?.score??0;
  return (cons*1.2) + (Math.max(-0.2, Math.min(0.8, va))*0.9) + (Math.max(-0.2, Math.min(0.2, ob))*1.0);
}
function sizingPlan(engine, exp){
  if(engine==="EXPLOSIE"){
    if(exp>=1.35) return { suggestedSizePct:100, label:"A (sterk)" };
    if(exp>=1.05) return { suggestedSizePct:80,  label:"B (oké)" };
    return { suggestedSizePct:50, label:"C (twijfel)" };
  }else{
    if(exp>=1.25) return { suggestedSizePct:100, label:"A (sterk)" };
    if(exp>=1.00) return { suggestedSizePct:90,  label:"B (oké)" };
    return { suggestedSizePct:60, label:"C (twijfel)" };
  }

function tradeManagementPlanPct(engine){
  // Alles in % vanaf entry prijs. 1R = |stopPct|.
  if(engine==="EXPLOSIE"){
    const stopPct = -6;   // -1R
    const beAtPct = +6;   // +1R
    const tp1Pct  = +12;  // +2R (30% winst)
    return {
      stopPct, beAtPct, tp1Pct,
      rules: [
        "Hard stop: -6% (nooit verlagen)",
        "Bij +6%: stop naar break-even",
        "Bij +12%: neem 30% winst",
        "Edge draait (volAcc < 0 of OB <= 0): verkoop 50%",
        "Laatste 20%: sluit bij 2 scans negatieve OB"
      ]
    };
  } else {
    const stopPct = -4;  // -1R
    const beAtPct = +4;  // +1R
    const tp1Pct  = +6;  // +1.5R (30% winst)
    return {
      stopPct, beAtPct, tp1Pct,
      rules: [
        "Hard stop: -4% (nooit verlagen)",
        "Bij +4%: stop naar break-even",
        "Bij +6%: neem 30% winst",
        "Edge draait (flat breekt / consistency zakt): verkoop 50%",
        "Laatste 20%: sluit bij 2 scans zwakke condities"
      ]
    };
  }
}
}
function tradeManagementPlan(engine){
  return (engine==="EXPLOSIE")
    ? { hardStop:"-1R (altijd)", breakevenAt:"+1R -> SL naar BE", partialTP:"+2R -> neem 30% winst", edgeExit:"Als volAcc < 0 of OB <= 0: verkoop 50%. Laatste 20% sluit bij 2 scans negatieve OB." }
    : { hardStop:"-1R (altijd)", breakevenAt:"+1R -> SL naar BE", partialTP:"+1.5R -> neem 30% winst", edgeExit:"Als priceFlat breekt (>3%) of consistency zakt: verkoop 50%. Laatste 20% sluit bij 2 scans zwakke condities." };
}

async function run(){
  // ---- PORTFOLIO (voor gate ALLOW/SUPPRESS) ----
  let portfolio = null;
  try{
    portfolio = readJsonSafe(path.join(OUT_DIR,"portfolio.json"), null);
  }catch{ portfolio = null; }

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

  const started=nowIso();
  const memAllRaw = readJsonSafe(MEM_OUT, {});
  const memAll = (memAllRaw && typeof memAllRaw==="object") ? memAllRaw : {};

  const regimeInfo = await detectRegime();

  let bitgetMap = {};
  try { bitgetMap = await loadBitgetUsdtSpotSymbols(); }
  catch(e){ console.log("⚠️ Bitget symbols load fail:", e?.message || e); bitgetMap = {}; }

  // 500 coins ophalen via CoinGecko (kan 429 geven; dan faalt scan -> oude output blijft zichtbaar)
  const all=[];
  const seenIds=new Set();

  for(let page=1; page<=CFG.cg.pages; page++){
    const url=
      "https://api.coingecko.com/api/v3/coins/markets" +
      `?vs_currency=${encodeURIComponent(CFG.cg.vs)}` +
      `&order=${encodeURIComponent(CFG.cg.order)}` +
      `&per_page=${CFG.cg.perPage}` +
      `&page=${page}` +
      `&sparkline=false` +
      `&price_change_percentage=24h`;

    const data = await fetchJson(url, 4);
    if(!Array.isArray(data) || data.length===0) break;

    for(const x of data){
      if(!x?.id || seenIds.has(x.id)) continue;
      seenIds.add(x.id);

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
        ch24:n(x.price_change_percentage_24h_in_currency ?? x.price_change_percentage_24h),
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

  const bull={ entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };
  const bear={ entry_entry:[], entry_hold:[], entry_sell:[], almost:[], buildup:[], radar:[] };

  async function attachOB(row){
    if(row.finalStage!=="ALMOST" && row.finalStage!=="ENTRY") return row;
    const sym = bitgetMap?.[row.symbol];
    if(!sym) return row;

    try{
      const obRaw = await fetchBitgetOrderbookSpot(sym, CFG.ob.depthLimit);
      const m = calcObMetrics(obRaw, row.price, CFG.ob.depthPct);
      row.ob = m ? { source:"bitget", symbol:sym, depthPct:CFG.ob.depthPct, score:m.score, spreadPct:m.spreadPct, bidUsd:m.bidUsd, askUsd:m.askUsd } : null;
    }catch{
      row.ob = null;
    }
    return row;
  }

  let obCalls=0;

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
    const engine=pickEngine(regimeInfo.regime, volAcc, flat);

    // ✅ NIEUWE COIN: DIRECT RADAR OUTPUT (RADAR LOCK)
    if(mem.totalScans===1){
      mem.stage="RADAR";
      mem.scansInStage=1;
      mem.lastExplain=`Nieuw gezien → RADAR lock (1/${CFG.funnel.minScansToLeaveRadar}).`;
      memAll[key]=mem;

      const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
        rangePct:c.range, ctl:c.ctl, side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
        desiredStage:"RADAR", finalStage:"RADAR", scansInStage:mem.scansInStage, totalScans:mem.totalScans,
        consistency:cons, volAcceleration:volAcc, priceFlatPct:flat, ob:null, risk:null, tradePlan:null, explain:mem.lastExplain
      };
      (side==="BULL"?bull.radar:bear.radar).push(row);
      continue;
    }

    // ✅ COIN MOET BLIJVEN PRESTEREN (anders 1 stap terug)
    if(!passSide){
      const curI=stageIndex(mem.stage);
      mem.stage = CFG.funnel.demoteOneStep ? STAGES[Math.max(0,curI-1)] : "RADAR";
      mem.scansInStage=1;
      mem.lastExplain="Faalt basis → 1 stap terug.";
      memAll[key]=mem;
      continue;
    }

    // RADAR lock tot 2 scans
    if(mem.stage==="RADAR" && mem.totalScans < CFG.funnel.minScansToLeaveRadar){
      mem.scansInStage += 1;
      mem.lastExplain=`RADAR lock: ${mem.totalScans}/${CFG.funnel.minScansToLeaveRadar} scans.`;
      memAll[key]=mem;

      const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
        rangePct:c.range, ctl:c.ctl, side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
        desiredStage:"RADAR", finalStage:"RADAR", scansInStage:mem.scansInStage, totalScans:mem.totalScans,
        consistency:cons, volAcceleration:volAcc, priceFlatPct:flat, ob:null, risk:null, tradePlan:null, explain:mem.lastExplain
      };
      (side==="BULL"?bull.radar:bear.radar).push(row);
      continue;
    }

    const tScore = (side==="BULL") ? timingScoreBull(c) : timingScoreBear(c);

    const buildupCoreOk = passStageMin(c,"BUILDUP") && tScore>=2 && cons>=0.82;
    const buildupEngineOk = (engine==="EXPLOSIE") ? (volAcc>=CFG.engines.EXPLOSIE.buildUpVolAccMin)
                                                  : (flat!=null && flat<=CFG.engines.ACCUMULATIE.priceFlatMax);

    const almostOk = passStageMin(c,"ALMOST") && (
      (engine==="EXPLOSIE")
        ? (flat!=null && flat<=CFG.engines.EXPLOSIE.priceFlatMax && volAcc>=CFG.engines.EXPLOSIE.buildUpVolAccMin)
        : (flat!=null && flat<=CFG.engines.ACCUMULATIE.priceFlatMax)
    );

    const entryBase = passStageMin(c,"ENTRY") && mem.totalScans>=CFG.funnel.minTotalScansForEntry && tScore>=3;

    const entryGateOk = (engine==="EXPLOSIE")
      ? (regimeInfo.regime==="HIGH_VOL" && volAcc>=CFG.engines.EXPLOSIE.entryVolAccMin)
      : (regimeInfo.regime==="GRIND" && flat!=null && flat<=CFG.engines.ACCUMULATIE.priceFlatMax);

    let desired="RADAR";
    if(buildupCoreOk && buildupEngineOk) desired="BUILDUP";
    if(desired==="BUILDUP" && almostOk) desired="ALMOST";
    if(desired==="ALMOST" && entryBase && entryGateOk) desired="ENTRY";

    const nextStage = CFG.funnel.promoteOneStep ? moveOneStep(mem.stage, desired) : desired;
    if(nextStage===mem.stage) mem.scansInStage += 1;
    else { mem.stage=nextStage; mem.scansInStage=1; }

    if(mem.stage==="BUILDUP" && mem.scansInStage < CFG.funnel.minBuildUpScans){
      mem.lastExplain=`BUILDUP bevestiging: ${mem.scansInStage}/${CFG.funnel.minBuildUpScans}.`;
    }else{
      mem.lastExplain=`OK: regime=${regimeInfo.regime}, engine=${engine}, timing=${tScore}/4, cons=${Math.round(cons*100)}%, volAcc=${Math.round(volAcc*100)}%, flat=${flat==null?"n/a":flat.toFixed(2)+"%"}`;
    }

    const row={ id:c.id, symbol:c.symbol, name:c.name, price:c.price, mcap:c.mcap, vol24h:c.vol, vm:c.vm, ch24:c.ch24,
      rangePct:c.range, ctl:c.ctl, side, regime:regimeInfo.regime, btcRange24h:regimeInfo.btcRange24h, engine,
      desiredStage:desired, finalStage:mem.stage, scansInStage:mem.scansInStage, totalScans:mem.totalScans,
      consistency:cons, volAcceleration:volAcc, priceFlatPct:flat, ob:null, risk:null, tradePlan:null, explain:mem.lastExplain
    };

    // OB alleen almost/entry (cap om API te sparen)
    if((row.finalStage==="ALMOST" || row.finalStage==="ENTRY") && obCalls<40){
      obCalls++;
      await attachOB(row);
      await sleep(170);
    }

    // ENTRY vereist OB confirmatie, anders terug naar ALMOST
    if(row.finalStage==="ENTRY"){
      const okOb = obPassForEntry(side, engine, row?.ob?.score);
      if(!okOb){
        row.finalStage="ALMOST";
        mem.stage="ALMOST";
        mem.scansInStage=1;
        mem.lastExplain="ENTRY afgekeurd: OB ontbreekt of te zwak → terug naar ALMOST.";
        row.explain = mem.lastExplain;
      }else{
        
const exp = expectancyProxy(row);
const sp = sizingPlan(engine, exp);
const plan = tradeManagementPlanPct(engine);

// default gate
let gate = "ALLOW";
let gateReason = "OK";

// enforce rules (als portfolio bestaat)
if(portfolio){
  const dd = ddPct(portfolio);
  const c = openCounts(portfolio);

  const maxDD = Number(portfolio.maxDrawdownPct ?? -8);
  if(dd <= maxDD){
    gate = "SUPPRESS";
    gateReason = `DD kill switch (${dd.toFixed(2)}% <= ${maxDD}%)`;
  }

  const maxTotal = Number(portfolio.maxTotalOpenRiskPct ?? 4);
  const addOpenRisk = (Number(sp.suggestedSizePct) * Math.abs(Number(plan.stopPct))) / 100;

  if(gate==="ALLOW" && (c.openRiskPct + addOpenRisk) > maxTotal){
    gate = "SUPPRESS";
    gateReason = `Max open risk (${(c.openRiskPct+addOpenRisk).toFixed(2)}% > ${maxTotal}%)`;
  }

  if(gate==="ALLOW" && engine==="EXPLOSIE" && c.explosie >= Number(portfolio.maxOpenExplosie ?? 2)){
    gate = "SUPPRESS";
    gateReason = "Max EXPLOSIE trades bereikt";
  }
  if(gate==="ALLOW" && engine==="ACCUMULATIE" && c.accu >= Number(portfolio.maxOpenAccu ?? 3)){
    gate = "SUPPRESS";
    gateReason = "Max ACCUMULATIE trades bereikt";
  }
}

row.risk = {
  expectancyProxy:Number(exp.toFixed(3)),
  sizingLabel:sp.label,
  suggestedSizePct:sp.suggestedSizePct,
  gate,
  gateReason
};

row.tradePlan = plan;
      }
    }

    memAll[key]=mem;

    const bucket = (side==="BULL") ? bull : bear;
    if(row.finalStage==="RADAR") bucket.radar.push(row);
    else if(row.finalStage==="BUILDUP") bucket.buildup.push(row);
    else if(row.finalStage==="ALMOST") bucket.almost.push(row);
    else if(row.finalStage==="ENTRY"){
      const st = entryState(side, row);
      if(st==="HOLD") bucket.entry_hold.push(row);
      else if(st==="SELL") bucket.entry_sell.push(row);
      else bucket.entry_entry.push(row);
    } else bucket.radar.push(row);
  }

  function sortRows(a,b){
    const ao=(a.ob?.score??0), bo=(b.ob?.score??0);
    const av=(a.vm||0)+(a.volAcceleration||0)+(ao*0.5);
    const bv=(b.vm||0)+(b.volAcceleration||0)+(bo*0.5);
    return bv-av;
  }
  for(const k of Object.keys(bull)) bull[k].sort(sortRows);
  for(const k of Object.keys(bear)) bear[k].sort(sortRows);

  const meta={
    ts: started,
    pulled: { coinsAfterPool: all.length, cgPages: CFG.cg.pages, cgPerPage: CFG.cg.perPage },
    regime: regimeInfo,
    stageMin: CFG.stageMin,
    bands: { bull: CFG.bullBands, bear: CFG.bearBands },
    notes: {
      rule1:"Nieuwe coin -> direct zichtbaar in RADAR (RADAR lock).",
      rule2:"Coins moeten blijven presteren, anders 1 stap terug.",
      rule3:"OB alleen Almost/Entry en ENTRY vereist OB bevestiging.",
      rule4:"Regime + Engine sturen strengheid.",
      rule5:"/bull en /bear routes werken (geen Not found)."
    }
  };

  writeJson(BULL_OUT, { side:"BULL", ...meta, tables: bull });
  writeJson(BEAR_OUT, { side:"BEAR", ...meta, tables: bear });
  writeJson(MEM_OUT, memAll);

  console.log("✅ scan klaar:", started);
  console.log("Pool coins:", all.length, "| OB calls:", obCalls);
  console.log("Regime:", regimeInfo.regime, "| BTC range:", regimeInfo.btcRange24h);
}

run().catch(e=>{
  console.error("❌ Scan error:", e?.message || e);
  process.exit(1);
});
