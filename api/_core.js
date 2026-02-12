import { kv } from "@vercel/kv";

const fetchFn = globalThis.fetch;
if (!fetchFn) throw new Error("fetch ontbreekt. Vercel Node runtime issue.");

export const CFG = {
  pool: {
    mcapMin: 3_000_000,
    mcapMax: 400_000_000,
    volMin: 250_000,
    vmMin: 0.10
  },
  bands: { lowPct: 10, highPct: 90 },
  memory: {
    maxScans: 30,
    lastN: 6
  },
  stages: {
    minScansToLeaveRadar: 2,
    minTotalScansForEntry: 5,
    entryMinVol: 1_500_000,
    entryMinVm: 0.28,
    buildUpConsistency: 0.82,
    buildUpVolAccMin: 0.20,
    entryVolAccMin: 0.30,
    flatMaxAccu: 0.03,
    flatMaxExpl: 0.04
  },
  orderbook: {
    depthPct: 2,          // binnen 2% van mid
    historyN: 50,
    zBull: 1.0,
    zBear: -1.0
  },
  portfolio: {
    maxOpenRiskPct: 4,
    maxOpenExpl: 2,
    maxOpenAccu: 3
  },
  hedgeMode: true
};

function now(){ return Date.now(); }

function percentile(arr, p){
  if(!arr.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const idx = (p/100)*(a.length-1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if(lo===hi) return a[lo];
  const w = idx-lo;
  return a[lo]*(1-w) + a[hi]*w;
}

function safeNum(x, d=null){
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}

export async function fetchJSON(url, opts={}, tries=3){
  let lastErr=null;
  for(let i=0;i<tries;i++){
    try{
      const r = await fetchFn(url, { ...opts, headers:{ "accept":"application/json", ...(opts.headers||{}) } });
      if(!r.ok){
        const t = await r.text();
        throw new Error(`HTTP ${r.status} ${t?.slice?.(0,200) || ""}`.trim());
      }
      return await r.json();
    }catch(e){
      lastErr = e;
      await new Promise(res=>setTimeout(res, 300*(i+1)));
    }
  }
  throw lastErr;
}

/**
 * Bitget spot symbols list
 * We gebruiken dit om "Bitget-only" te garanderen.
 */
export async function getBitgetSpotSymbols(){
  // We proberen meerdere endpoints (Bitget wisselt wel eens)
  const urls = [
    "https://api.bitget.com/api/v2/spot/public/symbols",
    "https://api.bitget.com/api/spot/v1/public/products"
  ];
  for(const u of urls){
    try{
      const j = await fetchJSON(u, {}, 2);
      const data = j?.data || j?.data?.data || j?.data?.result || j?.data?.list || j?.data;
      const out = [];
      if(Array.isArray(data)){
        for(const it of data){
          const sym = it?.symbol || it?.symbolName || it?.symbolCode;
          const quote = it?.quoteCoin || it?.quoteCoinName || it?.quote || it?.quoteCurrency;
          const base  = it?.baseCoin  || it?.baseCoinName  || it?.base  || it?.baseCurrency;
          if(sym && (quote==="USDT" || String(sym).toUpperCase().endsWith("USDT"))){
            out.push({
              symbol: String(sym).toUpperCase(),
              base: String(base||"").toUpperCase(),
              quote: "USDT"
            });
          }
        }
      }
      if(out.length) return out;
    }catch(e){}
  }
  return [];
}

export async function getCoinGeckoPool(){
  // CoinGecko markets
  const url = "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h";
  const arr = await fetchJSON(url, {}, 3);
  const pool = [];
  for(const c of arr){
    const mcap = safeNum(c.market_cap, 0);
    const vol  = safeNum(c.total_volume, 0);
    const price= safeNum(c.current_price, null);
    const ch24 = safeNum(c.price_change_percentage_24h, null);
    if(price==null || ch24==null) continue;

    const vm = (mcap>0) ? (vol/mcap) : 0;
    if(mcap < CFG.pool.mcapMin) continue;
    if(mcap > CFG.pool.mcapMax) continue;
    if(vol  < CFG.pool.volMin) continue;
    if(vm   < CFG.pool.vmMin)  continue;

    pool.push({
      id: c.id,
      symbol: String(c.symbol).toUpperCase(),
      name: c.name,
      price,
      mcap,
      vol,
      vm,
      ch24
    });
  }
  return pool;
}

export function timingScore(side, c){
  // range/ctl hebben we niet uit CG markets -> we maken score simpel en stabiel (niet gokken met OHLC)
  // Score (0-3): ch24 sign, vm >=0.14, vol >=1m
  let s=0;
  if(side==="bull" && c.ch24>0) s++;
  if(side==="bear" && c.ch24<0) s++;
  if(c.vm >= 0.14) s++;
  if(c.vol >= 1_000_000) s++;
  return s;
}

export function decideSide(pool){
  const chs = pool.map(x=>x.ch24).filter(Number.isFinite);
  const low  = percentile(chs, CFG.bands.lowPct);
  const high = percentile(chs, CFG.bands.highPct);
  return { low, high };
}

export function engineFor(c){
  // Simpele engine keuze:
  // - EXPLOSIE als vm hoog en vol hoog
  // - anders ACCUMULATIE
  if(c.vm >= 0.28 && c.vol >= 1_500_000) return "EXPLOSIE";
  return "ACCUMULATIE";
}

export function calcFlatness(hist){
  // laatste 6 prijzen: (max-min)/min
  const last = hist.slice(-CFG.memory.lastN);
  if(last.length < 3) return null;
  const ps = last.map(x=>x.price).filter(Number.isFinite);
  if(ps.length < 3) return null;
  const mn = Math.min(...ps);
  const mx = Math.max(...ps);
  if(mn<=0) return null;
  return (mx-mn)/mn;
}

export function calcVolAcc(hist){
  const last = hist.slice(-CFG.memory.lastN);
  if(last.length < 6) return null;
  const a = last.slice(-3).map(x=>x.vol).filter(Number.isFinite);
  const b = last.slice(0,3).map(x=>x.vol).filter(Number.isFinite);
  const avg = (arr)=> arr.reduce((s,x)=>s+x,0)/Math.max(1,arr.length);
  const av1 = avg(a), av0 = avg(b);
  if(av0<=0) return null;
  return (av1-av0)/av0;
}

export function consistency(hist){
  const last = hist.slice(-CFG.memory.lastN);
  if(!last.length) return 0;
  const ok = last.filter(x=>x.passSide===true).length;
  return ok/last.length;
}

export async function loadMem(side, sym){
  const k = `mem:${side}:${sym}`;
  const obj = await kv.get(k);
  return obj || { hist: [], stage:"RADAR", scansInStage:0, totalScans:0, obHist:[] };
}

export async function saveMem(side, sym, mem){
  const k = `mem:${side}:${sym}`;
  await kv.set(k, mem);
}

export function oneStepTransition(mem, wantStage){
  // max 1 stap per scan
  const order = ["RADAR","BUILDUP","ALMOST","ENTRY"];
  const cur = mem.stage || "RADAR";
  const ci = order.indexOf(cur);
  const wi = order.indexOf(wantStage);
  if(wi===ci) return cur;
  if(wi>ci) return order[Math.min(ci+1, order.length-1)];
  return order[Math.max(ci-1, 0)];
}

/**
 * Orderbook: probeer Bitget endpoints (v2 & v1) en parse flexibel.
 */
export async function fetchBitgetOrderbook(bitgetSymbol, limit=50){
  const sym = String(bitgetSymbol).toUpperCase();

  const urls = [
    `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(sym)}&limit=${limit}`,
    `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(sym)}&limit=${limit}`,
    `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(sym)}&type=step0&limit=${limit}`
  ];

  let lastErr=null;
  for(const u of urls){
    try{
      const j = await fetchJSON(u, {}, 2);
      let data = j?.data ?? j?.data?.data ?? j?.data?.result ?? j?.data;
      if(Array.isArray(data) && data.length===1) data = data[0];

      const bids = data?.bids || data?.bid || data?.buy || data?.data?.bids;
      const asks = data?.asks || data?.ask || data?.sell || data?.data?.asks;

      const norm = (arr)=>{
        if(!Array.isArray(arr)) return [];
        return arr.map(x=>{
          if(Array.isArray(x)) return [safeNum(x[0],null), safeNum(x[1],null)];
          if(typeof x==="object" && x) return [safeNum(x.price,null), safeNum(x.size ?? x.amount ?? x.vol, null)];
          return [null,null];
        }).filter(x=>x[0]!=null && x[1]!=null);
      };

      const B = norm(bids);
      const A = norm(asks);
      if(B.length && A.length) return { bids:B, asks:A };
      throw new Error("No bids/asks in response");
    }catch(e){
      lastErr = e;
    }
  }
  throw lastErr || new Error("Orderbook failed");
}

export function calcObScore(ob){
  const bids = ob.bids, asks = ob.asks;
  const bestBid = bids[0]?.[0];
  const bestAsk = asks[0]?.[0];
  if(!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;

  const mid = (bestBid + bestAsk)/2;
  const depth = CFG.orderbook.depthPct/100;

  const minBid = mid*(1-depth);
  const maxAsk = mid*(1+depth);

  let bidUsd=0, askUsd=0;
  for(const [p,s] of bids){
    if(p < minBid) break;
    bidUsd += p*s;
  }
  for(const [p,s] of asks){
    if(p > maxAsk) break;
    askUsd += p*s;
  }
  const den = bidUsd + askUsd;
  const obScore = den>0 ? (bidUsd-askUsd)/den : 0;
  const spreadPct = ((bestAsk-bestBid)/mid)*100;

  return { obScore, bidsUsd:bidUsd, asksUsd:askUsd, mid, spreadPct, depthPct:CFG.orderbook.depthPct };
}

export function zScoreFromHist(hist, x){
  const arr = hist.filter(Number.isFinite);
  if(arr.length < 10) return null;
  const mean = arr.reduce((s,v)=>s+v,0)/arr.length;
  const varr = arr.reduce((s,v)=>s+(v-mean)*(v-mean),0)/arr.length;
  const sd = Math.sqrt(varr);
  if(sd<=0) return 0;
  return (x-mean)/sd;
}

export async function portfolioGate(engine){
  // Basis risk engine (KV state) — geen echte trades, alleen "mag / mag niet"
  const st = (await kv.get("portfolio:state")) || { open: [] };
  const open = Array.isArray(st.open) ? st.open : [];

  const openExpl = open.filter(x=>x.engine==="EXPLOSIE").length;
  const openAccu = open.filter(x=>x.engine==="ACCUMULATIE").length;

  if(engine==="EXPLOSIE" && openExpl >= CFG.portfolio.maxOpenExpl) return { ok:false, reason:"Max open EXPLOSIE bereikt" };
  if(engine==="ACCUMULATIE" && openAccu >= CFG.portfolio.maxOpenAccu) return { ok:false, reason:"Max open ACCUMULATIE bereikt" };

  // totaal risk pct: optioneel (als jij later sizePct invult)
  return { ok:true, reason:"OK" };
}
