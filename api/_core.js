import { kv } from "@vercel/kv";

const fetchFn = globalThis.fetch;
if (!fetchFn) throw new Error("fetch is not available. Vercel must run Node runtime.");

export const CFG = {
  // Poolfilters (basis, veilig)
  mcapMin: 3_000_000,
  mcapMax: 400_000_000,
  volMin: 250_000,
  vmMin: 0.10,

  // Funnel timing
  minScansToLeaveRadar: 2,
  minTotalScansForEntry: 5,

  // Buildup/Almost/Entry gates
  buildupConsistencyMin: 0.82,
  buildupVolAccMin: 0.20,
  entryVolMin: 1_500_000,
  entryVmMin: 0.28,
  entryVolAccMin: 0.30,
  flatMaxBuildup: 0.030, // 3%
  flatMaxAlmost: 0.040,  // 4%

  // Orderbook gate
  depthPct: 0.02,
  obZBull: 1.0,
  obZBear: -1.0,
  obHistMax: 50,
  obMinSamples: 12,

  // Risk engine (lightweight, maar echt)
  maxDrawdownPct: -8.0,
  maxOpenBull: 2,
  maxOpenBear: 2,

  // Hedge mode: als bull en bear tegelijk entries hebben -> toegestaan, maar we labelen het
  hedgeMode: true
};

export function json(res, status=200){
  return new Response(JSON.stringify(res), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control":"no-store" }
  });
}

export function now(){ return Date.now(); }

export function pct(n){ return (n*100); }

export function clamp(n,min,max){ return Math.max(min, Math.min(max, n)); }

export function safeNum(x, fallback=0){
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

export function computePercentile(sortedArr, p){
  // p in [0..1], sorted ascending
  if(!sortedArr.length) return 0;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if(lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo]*(1-w) + sortedArr[hi]*w;
}

export function timingScore(side, c){
  // 0..4
  const ch24 = c.ch24;
  const vm   = c.vm;
  const rng  = c.range24;
  const ctl  = c.ctl;

  let s=0;
  if(side==="bull"){
    if(ch24>0) s++;
    if(vm>=0.14) s++;
    if(rng>=4.2 && rng<=25) s++;
    if(ctl>=0.70) s++;
  }else{
    if(ch24<0) s++;
    if(vm>=0.14) s++;
    if(rng>=4.2 && rng<=25) s++;
    if(ctl<=0.30) s++;
  }
  return s;
}

export function enginePick(c){
  // simpel maar logisch:
  // - als flatness heel laag: ACCUMULATIE
  // - anders: EXPLOSIE
  return (c.flatness <= 0.02) ? "ACCUMULATIE" : "EXPLOSIE";
}

export function computeFlatness(prices){
  if(prices.length < 2) return 0.0;
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if(min<=0) return 0.0;
  return (max - min) / min;
}

export function avg(arr){
  if(!arr.length) return 0;
  return arr.reduce((a,b)=>a+b,0)/arr.length;
}

export function std(arr){
  if(arr.length<2) return 0;
  const m = avg(arr);
  const v = avg(arr.map(x=>(x-m)**2));
  return Math.sqrt(v);
}

export async function getBitgetUsdtSet(){
  // cache 6 uur in KV
  const key = "bitget:usdt:set";
  const ttlKey = "bitget:usdt:set:ts";
  const ts = await kv.get(ttlKey);
  if(ts && (Date.now()-ts) < 6*60*60*1000){
    const cached = await kv.get(key);
    if(cached && Array.isArray(cached)) return new Set(cached);
  }

  // Bitget spot tickers
  const url = "https://api.bitget.com/api/v2/spot/market/tickers?symbolType=SPOT";
  const r = await fetchFn(url);
  const j = await r.json();
  const list = j?.data || [];
  const set = new Set();
  for(const t of list){
    const s = (t?.symbol || "").toUpperCase();
    if(s.endsWith("USDT")) set.add(s);
  }
  const arr = Array.from(set);
  await kv.set(key, arr);
  await kv.set(ttlKey, Date.now());
  return set;
}

export async function fetchCoinGeckoMarkets(){
  // top movers (we scannen groot genoeg en filteren daarna)
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h&locale=en";
  const r = await fetchFn(url, { headers: { "accept":"application/json" } });
  const j = await r.json();
  if(!Array.isArray(j)) throw new Error("CoinGecko response not array");
  return j;
}

export function mapCoin(m){
  const price = safeNum(m.current_price, 0);
  const high  = safeNum(m.high_24h, price);
  const low   = safeNum(m.low_24h, price);
  const vol   = safeNum(m.total_volume, 0);
  const mcap  = safeNum(m.market_cap, 0);
  const ch24  = safeNum(m.price_change_percentage_24h, 0);
  const rng   = (low>0) ? ((high-low)/low)*100 : 0;
  const ctl   = (high>low) ? clamp((price-low)/(high-low), 0, 1) : 0;

  const vm = (mcap>0) ? (vol/mcap) : 0;

  return {
    id: String(m.id || ""),
    symbol: String(m.symbol || "").toLowerCase(),
    price, high, low,
    vol, mcap,
    ch24, range24: rng, ctl,
    vm
  };
}

export function poolPass(c){
  if(c.mcap < CFG.mcapMin) return false;
  if(c.mcap > CFG.mcapMax) return false;
  if(c.vol  < CFG.volMin)  return false;
  if(c.vm   < CFG.vmMin)   return false;
  return true;
}

export function computeSideBands(allCh24){
  const sorted = [...allCh24].sort((a,b)=>a-b);
  const lowBand  = computePercentile(sorted, 0.10);
  const highBand = computePercentile(sorted, 0.90);
  return { lowBand, highBand };
}

export function sideFor(c, bands){
  if(c.ch24 >= bands.highBand) return "bull";
  if(c.ch24 <= bands.lowBand)  return "bear";
  return null;
}

export async function loadMem(side, sym){
  const key = `mem:${side}:${sym}`;
  const mem = await kv.get(key);
  if(mem && typeof mem==="object") return mem;
  return { totalScans: 0, stage: "RADAR", scansInStage: 0, hist: [] };
}

export async function saveMem(side, sym, mem){
  const key = `mem:${side}:${sym}`;
  await kv.set(key, mem);
}

export function computeDerived(mem){
  const last6 = mem.hist.slice(-6);
  const passSide = last6.map(x=>!!x.passSide);
  const consistency = last6.length ? (passSide.filter(Boolean).length / last6.length) : 0;

  const vols = last6.map(x=>safeNum(x.vol,0));
  const v1 = vols.slice(-3);
  const v0 = vols.slice(0, Math.max(0, vols.length-3));
  const avg1 = avg(v1);
  const avg0 = avg(v0.length ? v0 : v1);
  const volAcc = (avg0>0) ? ((avg1-avg0)/avg0) : 0;

  const prices = last6.map(x=>safeNum(x.price,0)).filter(x=>x>0);
  const flatness = computeFlatness(prices);

  return { consistency, volAcc, flatness };
}

export function stageAdvance(side, c, mem, d){
  // stage machine: RADAR -> BUILDUP -> ALMOST -> ENTRY
  // max 1 stap per scan, en kan terug als side niet meer klopt.
  const total = mem.totalScans;

  // Als deze scan niet meer in side valt: degrade hard
  if(!c.passSide){
    mem.stage = "RADAR";
    mem.scansInStage = 0;
    return;
  }

  // Radar hold
  if(mem.stage==="RADAR"){
    if(mem.scansInStage < CFG.minScansToLeaveRadar){
      return;
    }
    // promote naar BUILDUP als timing ok + consistency ok + (volAcc of flatness)
    const okTiming = c.timingScore >= 2;
    const okCons   = d.consistency >= CFG.buildupConsistencyMin;
    const okEng    = (c.engine==="EXPLOSIE")
      ? (d.volAcc >= CFG.buildupVolAccMin)
      : (d.flatness <= CFG.flatMaxBuildup);

    if(okTiming && okCons && okEng){
      mem.stage = "BUILDUP";
      mem.scansInStage = 0;
    }
    return;
  }

  if(mem.stage==="BUILDUP"){
    // promote naar ALMOST
    const okTiming = c.timingScore >= 2;
    const okEng = (c.engine==="EXPLOSIE")
      ? (d.flatness <= CFG.flatMaxAlmost && d.volAcc >= CFG.buildupVolAccMin)
      : (d.flatness <= CFG.flatMaxBuildup);

    if(okTiming && okEng){
      mem.stage = "ALMOST";
      mem.scansInStage = 0;
    }
    return;
  }

  if(mem.stage==="ALMOST"){
    // promote naar ENTRY (OB gate komt later)
    const base = (c.vol >= CFG.entryVolMin) && (c.vm >= CFG.entryVmMin);
    const enough = total >= CFG.minTotalScansForEntry;
    const okTiming = c.timingScore >= 3;
    const okEng = (c.engine==="EXPLOSIE")
      ? (d.volAcc >= CFG.entryVolAccMin)
      : (d.flatness <= CFG.flatMaxBuildup);

    if(base && enough && okTiming && okEng){
      mem.stage = "ENTRY";
      mem.scansInStage = 0;
    }
    return;
  }

  if(mem.stage==="ENTRY"){
    // blijft ENTRY tenzij side breekt (boven) -> RADAR
    return;
  }
}

export async function loadRisk(){
  const key="portfolio:risk";
  const r = await kv.get(key);
  if(r && typeof r==="object") return r;
  return { locked:false, openBull:0, openBear:0, ddPct:0 };
}

export async function saveRisk(r){
  await kv.set("portfolio:risk", r);
}

export function riskGate(side, risk){
  if(risk.locked) return { ok:false, reason:"Risk LOCK (drawdown)" };
  if(side==="bull" && risk.openBull >= CFG.maxOpenBull) return { ok:false, reason:"Max open BULL bereikt" };
  if(side==="bear" && risk.openBear >= CFG.maxOpenBear) return { ok:false, reason:"Max open BEAR bereikt" };
  return { ok:true, reason:"ok" };
}

export async function updateRiskFromSignals(dataBull, dataBear){
  // Lightweight: we tell UI what would be "open" based on ENTRY count
  // Real trades zijn er niet, maar we houden het consistent.
  const openBull = (dataBull?.funnel?.ENTRY || []).length;
  const openBear = (dataBear?.funnel?.ENTRY || []).length;
  const risk = await loadRisk();
  risk.openBull = openBull;
  risk.openBear = openBear;
  // locked blijft zoals user hem kan instellen later (nu auto false)
  await saveRisk(risk);
  return risk;
}
