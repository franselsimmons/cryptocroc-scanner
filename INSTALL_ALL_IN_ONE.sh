#!/usr/bin/env bash
set -e

echo "== CryptoCroc: FULL INSTALL (ALL-IN-ONE) =="

# 1) Mappen
mkdir -p cryptocroc-terminal/scanner cryptocroc-terminal/output public

# 2) package.json
cat << 'EOF2' > package.json
{
  "name": "cryptocroc-scanner",
  "private": true,
  "type": "module",
  "scripts": {
    "scan": "node cryptocroc-terminal/scanner/scan.js",
    "dev": "node server.mjs",
    "start": "node server.mjs"
  }
}
EOF2

# 3) server.mjs (scan direct + elke 10 min + /bull /bear routes + API + static)
cat << 'EOF2' > server.mjs
import http from "http";
import fs from "fs";
import path from "path";
import url from "url";
import { spawn } from "child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const OUT_DIR = path.join(__dirname, "cryptocroc-terminal", "output");
const PUBLIC_DIR = path.join(__dirname, "public");
const SCAN_PATH = path.join(__dirname, "cryptocroc-terminal", "scanner", "scan.js");

// simpele scan-lock + cooldown (voorkomt dubbel scannen)
const COOLDOWN_FILE = path.join(OUT_DIR, "last_scan_ts.json");
const COOLDOWN_MS = 2 * 60 * 1000;

function send(res, code, body, type = "text/plain") {
  res.writeHead(code, { "content-type": type });
  res.end(body);
}
function readFileSafe(p) { try { return fs.readFileSync(p); } catch { return null; } }
function readJsonSafe(p, fallback) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeJson(p, obj) { fs.writeFileSync(p, JSON.stringify(obj, null, 2)); }

let scanning = false;

function recentlyScanned() {
  const j = readJsonSafe(COOLDOWN_FILE, null);
  const last = j?.ts ? Date.parse(j.ts) : 0;
  if (!last) return false;
  return (Date.now() - last) < COOLDOWN_MS;
}
function markScanned() { writeJson(COOLDOWN_FILE, { ts: new Date().toISOString() }); }

function runScan() {
  if (scanning) return;
  if (recentlyScanned()) {
    console.log("⏭️ skip scan (cooldown actief)");
    return;
  }

  scanning = true;
  console.log("🔁 run scan:", new Date().toISOString());
  const p = spawn(process.execPath, [SCAN_PATH], { stdio: "inherit" });

  p.on("close", (code) => {
    scanning = false;
    if (code === 0) {
      markScanned();
      console.log("✅ scan done code:", code);
    } else {
      console.log("⚠️ scan failed code:", code, "(oude output blijft zichtbaar)");
    }
  });
}

// direct 1 scan + daarna elke 10 min
runScan();
setInterval(runScan, 10 * 60 * 1000);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  // API
  if (pathname === "/api/bull") {
    const b = readFileSafe(path.join(OUT_DIR, "bull.json"));
    return send(res, b ? 200 : 404, b ? b : Buffer.from("{}"), "application/json");
  }
  if (pathname === "/api/bear") {
    const b = readFileSafe(path.join(OUT_DIR, "bear.json"));
    return send(res, b ? 200 : 404, b ? b : Buffer.from("{}"), "application/json");
  }

  // Routes /bull en /bear -> index.html (fix "Not found")
  if (pathname === "/bull" || pathname === "/bear") {
    const idx = readFileSafe(path.join(PUBLIC_DIR, "index.html"));
    return send(res, idx ? 200 : 404, idx ? idx : "Missing index.html", "text/html");
  }

  // Static
  let filePath = (pathname === "/") ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext === ".html" ? "text/html" :
    ext === ".css" ? "text/css" :
    ext === ".js" ? "text/javascript" :
    "application/octet-stream";

  const b = readFileSafe(filePath);
  if (!b) return send(res, 404, "Not found");
  return send(res, 200, b, type);
});

server.listen(PORT, () => console.log(`✅ Server running: http://localhost:${PORT}`));
EOF2

# 4) scan.js (CG pool + regime + 2 engines + memory + OB on almost/entry + entry requires OB)
cat << 'EOF2' > cryptocroc-terminal/scanner/scan.js
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
}
function tradeManagementPlan(engine){
  return (engine==="EXPLOSIE")
    ? { hardStop:"-1R (altijd)", breakevenAt:"+1R -> SL naar BE", partialTP:"+2R -> neem 30% winst", edgeExit:"Als volAcc < 0 of OB <= 0: verkoop 50%. Laatste 20% sluit bij 2 scans negatieve OB." }
    : { hardStop:"-1R (altijd)", breakevenAt:"+1R -> SL naar BE", partialTP:"+1.5R -> neem 30% winst", edgeExit:"Als priceFlat breekt (>3%) of consistency zakt: verkoop 50%. Laatste 20% sluit bij 2 scans zwakke condities." };
}

async function run(){
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
        row.risk = {
          expectancyProxy:Number(exp.toFixed(3)),
          sizingLabel:sp.label,
          suggestedSizePct:sp.suggestedSizePct,
          maxOpenExplosie:CFG.risk.maxOpenExplosie,
          maxOpenAccu:CFG.risk.maxOpenAccu,
          maxTotalRiskPct:CFG.risk.maxTotalRiskPct,
          ddKillSwitchPct:CFG.risk.ddKillSwitchPct
        };
        row.tradePlan = tradeManagementPlan(engine);
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
EOF2

# 5) UI: index.html
cat << 'EOF2' > public/index.html
<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>CryptoCroc Scanner</title>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body>
  <header class="top">
    <div class="brand">
      <div class="logo">🐊</div>
      <div>
        <div class="title">CryptoCroc Scanner</div>
        <div class="sub">ENTRY boven — RADAR onder • regime + 2 engines • OB bij Almost/Entry</div>
      </div>
    </div>

    <div class="tabs">
      <button id="tabBull" class="tab">BULL</button>
      <button id="tabBear" class="tab">BEAR</button>
      <button id="btnRefresh" class="ghost">Refresh</button>
    </div>

    <div class="status">
      <div id="ts" class="pill">loading…</div>
      <div id="reg" class="pill">regime…</div>
      <div id="counts" class="pill">…</div>
    </div>
  </header>

  <main class="wrap">
    <section id="tables"></section>
  </main>

  <div id="modal" class="modal hidden">
    <div class="modalCard">
      <div class="modalHead">
        <div id="mTitle" class="mTitle"></div>
        <button id="mClose" class="x">✕</button>
      </div>
      <div id="mBody" class="mBody"></div>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>
EOF2

# 6) UI: styles.css
cat << 'EOF2' > public/styles.css
:root{
  --bg:#0b1220;
  --card:#0f1a33;
  --card2:#0c152b;
  --text:#e7ecff;
  --muted:#a9b3d6;
  --line:rgba(255,255,255,.08);
  --good:#33d17a;
  --bad:#ff4d4d;
}
*{ box-sizing:border-box; }
html,body{ height:100%; }
body{
  margin:0;
  background:linear-gradient(180deg,#070b14, var(--bg));
  color:var(--text);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
  overflow-x:hidden;
}
.wrap{ max-width:1200px; margin:0 auto; padding:16px; }
.top{
  position:sticky; top:0;
  backdrop-filter: blur(10px);
  background:rgba(7,11,20,.75);
  border-bottom:1px solid var(--line);
  padding:14px 16px;
  display:flex;
  gap:12px;
  align-items:center;
  justify-content:space-between;
}
.brand{ display:flex; gap:10px; align-items:center; }
.logo{
  width:42px;height:42px;border-radius:12px;
  display:grid;place-items:center;
  background:linear-gradient(180deg,#1b2a55,#0c152b);
  border:1px solid var(--line);
}
.title{ font-weight:800; letter-spacing:.3px; }
.sub{ color:var(--muted); font-size:12px; margin-top:2px; }
.tabs{ display:flex; gap:8px; }
.tab,.ghost{
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--text);
  padding:10px 12px;
  border-radius:12px;
  cursor:pointer;
}
.tab.active{
  background:linear-gradient(180deg,#1b2a55,#0c152b);
  border-color:rgba(120,160,255,.35);
}
.status{ display:flex; gap:8px; }
.pill{
  padding:8px 10px;
  border-radius:999px;
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--muted);
  font-size:12px;
}
.block{
  margin-top:14px;
  background:linear-gradient(180deg,var(--card),var(--card2));
  border:1px solid var(--line);
  border-radius:18px;
  overflow:hidden;
}
.blockHead{
  padding:12px 14px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  border-bottom:1px solid var(--line);
}
.blockTitle{ font-weight:800; }
.blockHint{ color:var(--muted); font-size:12px; }
.table{ width:100%; border-collapse:collapse; }
th,td{ padding:10px 12px; border-bottom:1px solid var(--line); font-size:13px; }
th{ color:var(--muted); font-weight:600; text-align:left; }
.row{ cursor:pointer; }
.row:hover{ background:rgba(255,255,255,.04); }
.badge{
  display:inline-flex; align-items:center; gap:6px;
  padding:4px 8px; border-radius:999px;
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--muted); font-size:12px;
}
.good{ color:var(--good); }
.bad{ color:var(--bad); }
.pb{
  width:110px;height:10px;border-radius:999px;
  background:rgba(255,255,255,.08);
  overflow:hidden;
  border:1px solid var(--line);
}
.pb > i{
  display:block;height:100%;
  background:linear-gradient(90deg,#2b6cff,#33d17a);
  width:0%;
}
.modal{
  position:fixed; inset:0;
  background:rgba(0,0,0,.55);
  display:grid; place-items:center;
  padding:16px;
}
.hidden{ display:none; }
.modalCard{
  width:min(900px,100%);
  background:linear-gradient(180deg,var(--card),var(--card2));
  border:1px solid var(--line);
  border-radius:18px;
  overflow:hidden;
}
.modalHead{
  display:flex; justify-content:space-between; align-items:center;
  padding:14px 14px;
  border-bottom:1px solid var(--line);
}
.mTitle{ font-weight:900; }
.x{
  border:1px solid var(--line);
  background:rgba(255,255,255,.04);
  color:var(--text);
  border-radius:10px;
  padding:8px 10px;
  cursor:pointer;
}
.mBody{ padding:14px; color:var(--text); }
.grid{
  display:grid;
  grid-template-columns:repeat(3, minmax(0,1fr));
  gap:10px;
}
.card{
  border:1px solid var(--line);
  background:rgba(255,255,255,.03);
  border-radius:14px;
  padding:10px;
}
.k{ color:var(--muted); font-size:12px; }
.v{ font-weight:800; margin-top:4px; }
.note{ margin-top:10px; color:var(--muted); font-size:12px; line-height:1.4; }
EOF2

# 7) UI: app.js (ENTRY boven, RADAR onder + popup met uitleg)
cat << 'EOF2' > public/app.js
const API = { bull:"/api/bull", bear:"/api/bear" };
let SIDE = (location.pathname.includes("bear") || location.hash === "#bear") ? "bear" : "bull";

const $ = (s)=>document.querySelector(s);
const elTables = $("#tables");
const elTs = $("#ts");
const elReg = $("#reg");
const elCounts = $("#counts");

$("#tabBull").onclick = ()=>setSide("bull");
$("#tabBear").onclick = ()=>setSide("bear");
$("#btnRefresh").onclick = ()=>load();

function setSide(s){
  SIDE = s;
  // maak /bull en /bear netjes, maar hash werkt ook
  if(location.pathname !== (s==="bear"?"/bear":"/bull")){
    history.replaceState({}, "", s==="bear"?"/bear":"\/bull");
  }
  renderTabs();
  load();
}
function renderTabs(){
  $("#tabBull").classList.toggle("active", SIDE==="bull");
  $("#tabBear").classList.toggle("active", SIDE==="bear");
}

function fmtMoney(x){
  if(x==null || !Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  if(abs >= 1e9) return (x/1e9).toFixed(2)+"B";
  if(abs >= 1e6) return (x/1e6).toFixed(2)+"M";
  if(abs >= 1e3) return (x/1e3).toFixed(2)+"K";
  return x.toFixed(2);
}
function fmtPct(x){
  if(x==null || !Number.isFinite(x)) return "—";
  return (x>=0?"+":"") + x.toFixed(2) + "%";
}
function clsPct(x){ return (x!=null && Number.isFinite(x)) ? (x>=0 ? "good" : "bad") : ""; }
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

function progress(stage, scansInStage, totalScans){
  if(stage==="RADAR") return clamp((scansInStage/2)*100, 5, 100);
  if(stage==="BUILDUP") return clamp((scansInStage/3)*100, 5, 100);
  if(stage==="ALMOST") return clamp((totalScans/5)*100, 5, 100);
  if(stage==="ENTRY") return 100;
  return 10;
}

function block(title, hint, rows){
  const wrap = document.createElement("div");
  wrap.className="block";

  const head = document.createElement("div");
  head.className="blockHead";
  head.innerHTML = `<div class="blockTitle">${title}</div><div class="blockHint">${hint}</div>`;
  wrap.appendChild(head);

  const table = document.createElement("table");
  table.className="table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>Coin</th>
        <th>Engine</th>
        <th>24h</th>
        <th>MCAP</th>
        <th>VOL</th>
        <th>VM</th>
        <th>OB</th>
        <th>Progress</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tb = table.querySelector("tbody");

  for(const r of rows){
    const tr = document.createElement("tr");
    tr.className="row";
    tr.onclick = ()=>openModal(r);

    const obScore = r?.ob?.score;
    const obTxt = (obScore==null || !Number.isFinite(obScore)) ? "n/a" : obScore.toFixed(3);
    const obCls = (obScore==null || !Number.isFinite(obScore)) ? "" : (obScore>=0 ? "good":"bad");

    const p = progress(r.finalStage, r.scansInStage, r.totalScans);

    tr.innerHTML = `
      <td><span class="badge">${r.symbol}</span> ${r.name}</td>
      <td><span class="badge">${r.engine || "—"}</span></td>
      <td class="${clsPct(r.ch24)}">${fmtPct(r.ch24)}</td>
      <td>${fmtMoney(r.mcap)}</td>
      <td>${fmtMoney(r.vol24h)}</td>
      <td>${r.vm!=null? r.vm.toFixed(3):"—"}</td>
      <td class="${obCls}">${obTxt}</td>
      <td><span class="pb"><i style="width:${p}%"></i></span></td>
    `;
    tb.appendChild(tr);
  }

  wrap.appendChild(table);
  return wrap;
}

function explainLines(r){
  const lines = [
    ["Stage", r.finalStage, "Waar de coin nu zit in de trechter."],
    ["Regime", r.regime || "—", "HIGH_VOL = wild, GRIND = rustiger."],
    ["Engine", r.engine || "—", "EXPLOSIE = volume versnelling, ACCUMULATIE = strak/flat."],
    ["Total scans", r.totalScans, "Hoe vaak we ‘m al zagen (memory)."],
    ["Scans in stage", r.scansInStage, "Hoe lang hij dit niveau vasthoudt."],
    ["Consistency", r.consistency!=null ? Math.round(r.consistency*100)+"%" : "—", "Hoe vaak hij in de laatste scans ‘goed’ was."],
    ["Vol acceleration", r.volAcceleration!=null ? Math.round(r.volAcceleration*100)+"%" : "—", "Versnelt volume of dooft het uit?"],
    ["Price flat", r.priceFlatPct!=null ? r.priceFlatPct.toFixed(2)+"%" : "—", "Hoe strak prijs beweegt (accumulatie)."],
    ["VM", r.vm!=null ? r.vm.toFixed(3) : "—", "Volume / MarketCap."],
    ["Explain", r.explain || "—", "Waarom hij hier zit / wat hij mist."]
  ];

  if(r.ob){
    lines.push(["OB score", r.ob.score!=null ? r.ob.score.toFixed(3) : "—", "Orderbook druk (+ bids / - asks)."]);
    lines.push(["Spread", r.ob.spreadPct!=null ? r.ob.spreadPct.toFixed(3)+"%" : "—", "Bid/ask verschil."]);
  } else {
    lines.push(["Orderbook", "n/a", "OB wordt alleen gedaan bij ALMOST/ENTRY, en soms faalt Bitget."]);
  }

  if(r.risk){
    lines.push(["Sizing", (r.risk.suggestedSizePct ?? "—") + "%", "Hoe groot je inzet (suggestie)."]);
    lines.push(["Label", r.risk.sizingLabel || "—", "A=sterk, B=oké, C=twijfel."]);
    lines.push(["Exposure", `${r.risk.maxOpenExplosie} explosie / ${r.risk.maxOpenAccu} accu`, "Max tegelijk open trades per engine."]);
  }
  if(r.tradePlan){
    lines.push(["Hard stop", r.tradePlan.hardStop, "Altijd. Geen discussies." ]);
    lines.push(["Break-even", r.tradePlan.breakevenAt, "Bij winst: risico eruit." ]);
    lines.push(["Partial TP", r.tradePlan.partialTP, "Pak winst zodat je curve sterk blijft." ]);
    lines.push(["Edge exit", r.tradePlan.edgeExit, "Als edge draait: afbouwen." ]);
  }

  return lines;
}

function openModal(r){
  $("#modal").classList.remove("hidden");
  $("#mTitle").textContent = `${r.symbol} • ${r.name} • ${r.finalStage}`;

  const grid = document.createElement("div");
  grid.className="grid";

  for(const [k,v,desc] of explainLines(r)){
    const c = document.createElement("div");
    c.className="card";
    c.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="note">${desc}</div>`;
    grid.appendChild(c);
  }

  const body = $("#mBody");
  body.innerHTML = "";
  body.appendChild(grid);
}

$("#mClose").onclick = ()=>$("#modal").classList.add("hidden");
$("#modal").onclick = (e)=>{ if(e.target.id==="modal") $("#modal").classList.add("hidden"); };

async function load(){
  renderTabs();
  elTables.innerHTML = "";

  const url = SIDE==="bull" ? API.bull : API.bear;

  let data;
  try{
    const r = await fetch(url, { cache:"no-store" });
    data = await r.json();
  }catch{
    elTables.textContent = "Kan data niet laden. Check of server draait.";
    return;
  }

  elTs.textContent = data?.ts ? `Last scan: ${data.ts}` : "Last scan: —";
  elReg.textContent = data?.regime?.regime ? `Regime: ${data.regime.regime}` : "Regime: —";

  const t = data?.tables || {};
  const total =
    (t.entry_entry?.length||0)+(t.entry_hold?.length||0)+(t.entry_sell?.length||0)+
    (t.almost?.length||0)+(t.buildup?.length||0)+(t.radar?.length||0);

  elCounts.textContent = `Coins in view: ${total}`;

  // ✅ ENTRY boven, RADAR onder
  elTables.appendChild(block("ENTRY • ENTRY", "Actie (plan + sizing in popup)", t.entry_entry||[]));
  elTables.appendChild(block("ENTRY • HOLD", "Sterk – vasthouden", t.entry_hold||[]));
  elTables.appendChild(block("ENTRY • SELL", "Niet doen / exit waarschuwing", t.entry_sell||[]));
  elTables.appendChild(block("ALMOST", "Bijna klaar (OB check actief)", t.almost||[]));
  elTables.appendChild(block("BUILDUP", "Bevestiging aan het bouwen", t.buildup||[]));
  elTables.appendChild(block("RADAR", "Nieuwe/early kandidaten", t.radar||[]));
}

load();
EOF2

echo "✅ Bestanden geplaatst."
echo "➡️ Start nu met:"
echo "   npm install"
echo "   npm run dev"
echo "Open dan:"
echo "   http://localhost:3000/bull"
echo "   http://localhost:3000/bear"
