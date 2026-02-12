import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

const CG = "https://api.coingecko.com/api/v3";
const BITGET = "https://api.bitget.com";

function now(){ return Date.now(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function percentile(arr, p){
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b)=>a-b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return s[lo];
  const w = idx - lo;
  return s[lo]*(1-w) + s[hi]*w;
}

export async function getBitgetSymbolsUSDT(){
  // Bitget endpoint: /api/v2/spot/public/symbols
  const url = `${BITGET}/api/v2/spot/public/symbols`;
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`Bitget symbols HTTP ${r.status}`);
  const j = await r.json();
  const list = (j && j.data) ? j.data : [];
  const set = new Set();
  for (const it of list){
    const sym = it.symbol;
    if (typeof sym === "string" && sym.endsWith("USDT")) set.add(sym);
  }
  return set;
}

export async function fetchCoinGeckoMarket(){
  // 250 per page, we pakken 2 pagina's (500) als basis.
  // (Snel + genoeg voor funnel. Later kun je opschalen.)
  const pages = [1,2];
  const out = [];
  for (const page of pages){
    const url = `${CG}/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${page}&sparkline=false&price_change_percentage=24h`;
    const r = await fetch(url, { headers: { "accept": "application/json" }});
    if (!r.ok) throw new Error(`CoinGecko HTTP ${r.status}`);
    const j = await r.json();
    if (Array.isArray(j)) out.push(...j);
  }
  return out;
}

export function poolFilter(c){
  const mcap = c.market_cap ?? 0;
  const vol = c.total_volume ?? 0;
  const vm = (mcap > 0) ? (vol / mcap) : 0;

  // jouw poolfilters (v2)
  const mcapMin = 3_000_000;
  const mcapMax = 400_000_000;
  const volMin  = 250_000;
  const vmMin   = 0.10;

  const ok =
    mcap >= mcapMin &&
    mcap <= mcapMax &&
    vol  >= volMin  &&
    vm   >= vmMin;

  return { ok, mcap, vol, vm };
}

export function timingScore(side, c, vm){
  const ch24 = c.price_change_percentage_24h ?? 0;
  const high = c.high_24h ?? null;
  const low  = c.low_24h ?? null;
  const price = c.current_price ?? null;

  let rangePct = null;
  if (high && low && low > 0) rangePct = ((high - low) / low) * 100;

  // close-to-range: (price - low)/(high-low)
  let ctl = null;
  if (high && low && high > low && price != null){
    ctl = (price - low) / (high - low);
  }

  let score = 0;
  if (side === "bull"){
    if (ch24 > 0) score++;
    if (vm >= 0.14) score++;
    if (rangePct != null && rangePct >= 4.2 && rangePct <= 25) score++;
    if (ctl != null && ctl >= 0.70) score++;
  } else {
    if (ch24 < 0) score++;
    if (vm >= 0.14) score++;
    if (rangePct != null && rangePct >= 4.2 && rangePct <= 25) score++;
    if (ctl != null && ctl <= 0.30) score++;
  }

  return { score, rangePct, ctl };
}

export async function loadMem(side, symbol){
  const key = `mem:${side}:${symbol}`;
  const v = await kv.get(key);
  if (v && typeof v === "object") return v;

  return {
    side,
    symbol,
    stage: "RADAR",
    stageScans: 0,
    totalScans: 0,
    hist: [],        // last 30 scan snapshots
    obHist: []       // last 50 obScore samples
  };
}

export async function saveMem(mem){
  const key = `mem:${mem.side}:${mem.symbol}`;
  await kv.set(key, mem);
}

export function calcDerived(mem){
  // last 6 scans stability
  const last6 = mem.hist.slice(-6);
  const passSide = last6.filter(x => x.passSide === true).length;
  const consistency = last6.length ? passSide / last6.length : 0;

  // volume acceleration: avg last3 vs prev3
  let volAcc = 0;
  if (last6.length >= 6){
    const a = last6.slice(0,3).reduce((s,x)=>s+(x.vol||0),0)/3;
    const b = last6.slice(3,6).reduce((s,x)=>s+(x.vol||0),0)/3;
    volAcc = (a>0) ? ((b-a)/a) : 0;
  }

  // price flatness: (max-min)/min over last6
  let flat = null;
  if (last6.length >= 6){
    const ps = last6.map(x=>x.price).filter(x=>typeof x==="number" && x>0);
    if (ps.length >= 6){
      const mn = Math.min(...ps);
      const mx = Math.max(...ps);
      flat = (mn>0) ? ((mx-mn)/mn)*100 : null;
    }
  }

  return { consistency, volAcc, flat };
}

export async function fetchOrderbookBitget(symbolUSDT){
  // Source seen in public snippet: /api/v2/spot/market/orderbook?symbol=XXXUSDT&type=step0
  const url = `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbolUSDT)}&type=step0`;
  const r = await fetch(url, { headers: { "accept": "application/json" }});
  if (!r.ok) throw new Error(`Bitget OB HTTP ${r.status}`);
  const j = await r.json();

  // Bitget returns data with bids/asks arrays (strings)
  const data = j.data || {};
  const bids = data.bids || [];
  const asks = data.asks || [];

  // mid & spread
  const bestBid = bids.length ? Number(bids[0][0]) : null;
  const bestAsk = asks.length ? Number(asks[0][0]) : null;
  const mid = (bestBid && bestAsk) ? (bestBid + bestAsk)/2 : null;
  const spreadPct = (bestBid && bestAsk && mid) ? ((bestAsk-bestBid)/mid)*100 : null;

  // score in USD depth: sum(price*size) within 2% from mid
  let bidUsd=0, askUsd=0;
  if (mid){
    const maxDev = mid * 0.02;
    for (const [pStr,sStr] of bids){
      const p = Number(pStr), s = Number(sStr);
      if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
      if (mid - p <= maxDev) bidUsd += p*s;
      else break;
    }
    for (const [pStr,sStr] of asks){
      const p = Number(pStr), s = Number(sStr);
      if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
      if (p - mid <= maxDev) askUsd += p*s;
      else break;
    }
  }

  const denom = (bidUsd + askUsd);
  const obScore = denom > 0 ? (bidUsd - askUsd) / denom : 0;

  return { raw: j, obScore, spreadPct };
}

export function zScoreFromHist(hist, x){
  const a = hist.slice(-50);
  if (a.length < 10) return 0; // nog te weinig data → neutraal
  const mean = a.reduce((s,v)=>s+v,0)/a.length;
  const varr = a.reduce((s,v)=>s+Math.pow(v-mean,2),0)/a.length;
  const sd = Math.sqrt(varr) || 1e-9;
  return (x - mean) / sd;
}

export function obGate(side, z){
  // threshold uit jouw spec
  return side === "bull" ? (z >= 1.0) : (z <= -1.0);
}

export function obStatusFromScore(side, obScore, spreadPct){
  // simpele HOLD/SELL regels (jij kunt dit later finetunen)
  // spreadPct null => geen status
  if (spreadPct == null) return "ENTRY";

  const spreadHold = 0.28;
  const spreadSell = 0.35;

  if (side === "bull"){
    if (obScore >= 0.18 && spreadPct <= spreadHold) return "HOLD";
    if (obScore <= -0.10 && spreadPct >= spreadSell) return "SELL";
    return "ENTRY";
  } else {
    if (obScore <= -0.18 && spreadPct <= spreadHold) return "HOLD";
    if (obScore >= 0.10 && spreadPct >= spreadSell) return "SELL";
    return "ENTRY";
  }
}

export function riskGateDummy(){
  // Portfolio engine placeholder: UI/scan blijft werken.
  // (Echte portfolio tracking kan pas als je posities + PnL opslaat.)
  return { ok: true, reason: null };
}

export function stageLogic(side, mem, snap){
  // snap = { price, vol, vm, ch24, passSide, timingScore, volAcc, flat }
  const minRadar = 2;
  const minTotalEntry = 5;

  const stage = mem.stage;

  // Default: blijf in stage, stageScans +1
  let nextStage = stage;

  if (stage === "RADAR"){
    if (mem.totalScans >= minRadar && snap.passSide && snap.timingScore >= 2 && snap.consistency >= 0.82){
      nextStage = "BUILDUP";
    }
  } else if (stage === "BUILDUP"){
    if (!snap.passSide) nextStage = "RADAR";
    else if (snap.timingScore >= 2){
      nextStage = "ALMOST";
    }
  } else if (stage === "ALMOST"){
    if (!snap.passSide) nextStage = "RADAR";
    else if (mem.totalScans >= minTotalEntry && snap.timingScore >= 3 && snap.vol >= 1_500_000 && snap.vm >= 0.28){
      nextStage = "ENTRY"; // echte OB gate gebeurt later
    }
  } else if (stage === "ENTRY"){
    if (!snap.passSide) nextStage = "ALMOST";
  }

  return nextStage;
}

export function makeSnapshot(ts, lowBand, highBand, arr){
  const byStage = { RADAR:[], BUILDUP:[], ALMOST:[], ENTRY:[], HOLD:[], SELL:[] };

  for (const c of arr){
    if (c.stage === "ENTRY"){
      if (c.obStatus === "HOLD") byStage.HOLD.push(c);
      else if (c.obStatus === "SELL") byStage.SELL.push(c);
      else byStage.ENTRY.push(c);
    } else if (byStage[c.stage]) {
      byStage[c.stage].push(c);
    }
  }

  const sortByScore = (a,b)=> (b.timingScore - a.timingScore) || (b.vm - a.vm);

  return {
    ts,
    lowBand,
    highBand,
    itemsTotal: arr.length,
    entry:  byStage.ENTRY.sort(sortByScore),
    hold:   byStage.HOLD.sort(sortByScore),
    sell:   byStage.SELL.sort(sortByScore),
    almost: byStage.ALMOST.sort(sortByScore),
    buildup:byStage.BUILDUP.sort(sortByScore),
    radar:  byStage.RADAR.sort(sortByScore)
  };
}
