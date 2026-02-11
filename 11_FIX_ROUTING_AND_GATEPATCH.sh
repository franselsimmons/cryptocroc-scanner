#!/usr/bin/env bash
set -e

echo "== Fix routing + scan gate/% plan =="

# -----------------------
# 1) server.mjs fix: /bull en /bear ook naar index.html
# -----------------------
cat << 'EOS' > server.mjs
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

const FILE_BULL = path.join(OUT_DIR,"bull.json");
const FILE_BEAR = path.join(OUT_DIR,"bear.json");
const FILE_PORTFOLIO = path.join(OUT_DIR,"portfolio.json");
const FILE_TRADES = path.join(OUT_DIR,"trades.jsonl");

function send(res, code, body, type="text/plain"){
  res.writeHead(code, { "content-type": type, "cache-control":"no-store" });
  res.end(body);
}
function readFileSafe(p){ try { return fs.readFileSync(p); } catch { return null; } }
function readJsonSafe(p, fallback){ try { return JSON.parse(fs.readFileSync(p,"utf8")); } catch { return fallback; } }
function writeJson(p, obj){ fs.writeFileSync(p, JSON.stringify(obj,null,2)); }

function readBody(req){
  return new Promise((resolve)=>{
    let data="";
    req.on("data",(c)=> data+=c);
    req.on("end",()=> resolve(data));
  });
}

let scanning = false;

function runScan(){
  if(scanning) return;
  scanning = true;

  console.log("🔁 run scan:", new Date().toISOString());
  const p = spawn(process.execPath, [SCAN_PATH], { stdio: "inherit" });

  p.on("close", (code)=>{
    scanning = false;
    console.log("✅ scan done code:", code);
  });
}

runScan();
setInterval(runScan, 10*60*1000);

function ensurePortfolio(){
  if(!fs.existsSync(FILE_PORTFOLIO)){
    writeJson(FILE_PORTFOLIO, {
      version:1,
      baseCurrency:"USD",
      startingBalance:1000,
      currentBalance:1000,
      peakBalance:1000,
      maxDrawdownPct:-8,
      maxTotalOpenRiskPct:4,
      maxOpenExplosie:2,
      maxOpenAccu:3,
      positions:[]
    });
  }
  if(!fs.existsSync(FILE_TRADES)){
    fs.writeFileSync(FILE_TRADES, "");
  }
}

function appendTrade(obj){
  fs.appendFileSync(FILE_TRADES, JSON.stringify(obj) + "\n");
}

function calcDD(port){
  const peak = Number(port.peakBalance ?? port.currentBalance ?? 0);
  const cur  = Number(port.currentBalance ?? 0);
  if(peak<=0) return 0;
  return ((cur-peak)/peak)*100;
}

function openPosition({ symbol, side, engine, entryPrice, sizePct, stopPct, tp1Pct, beAtPct }){
  ensurePortfolio();
  const port = readJsonSafe(FILE_PORTFOLIO, null);
  if(!port) throw new Error("portfolio.json unreadable");

  const price = Number(entryPrice);
  if(!Number.isFinite(price) || price<=0) throw new Error("entryPrice ongeldig");

  const sPct = Number(sizePct);
  if(!Number.isFinite(sPct) || sPct<=0) throw new Error("sizePct ongeldig");

  const dd = calcDD(port);
  if(dd <= (port.maxDrawdownPct ?? -8)) throw new Error("DD kill switch actief: geen nieuwe trades");

  const positions = Array.isArray(port.positions) ? port.positions : [];
  const openExpl = positions.filter(p=>p.isOpen && p.engine==="EXPLOSIE").length;
  const openAcc  = positions.filter(p=>p.isOpen && p.engine==="ACCUMULATIE").length;

  if(engine==="EXPLOSIE" && openExpl >= (port.maxOpenExplosie ?? 2)) throw new Error("Max EXPLOSIE trades bereikt");
  if(engine==="ACCUMULATIE" && openAcc >= (port.maxOpenAccu ?? 3)) throw new Error("Max ACCUMULATIE trades bereikt");

  const st = Number(stopPct);
  if(!Number.isFinite(st) || st>=0) throw new Error("stopPct moet negatief zijn (bv -6)");

  const openRiskPct = (sPct * Math.abs(st)) / 100;

  const totalOpenRiskPct =
    positions.filter(p=>p.isOpen).reduce((sum,p)=> sum + (Number(p.openRiskPct)||0), 0);

  const maxTotal = Number(port.maxTotalOpenRiskPct ?? 4);
  if(totalOpenRiskPct + openRiskPct > maxTotal){
    throw new Error(`Max totaal open risico overschreden (${(totalOpenRiskPct+openRiskPct).toFixed(2)}% > ${maxTotal}%)`);
  }

  const id = "pos_" + Math.random().toString(16).slice(2) + "_" + Date.now();

  const pos = {
    id,
    tsOpen: new Date().toISOString(),
    symbol,
    side,
    engine,
    entryPrice: price,
    sizePct: sPct,
    stopPct: Number(stopPct),
    tp1Pct: Number(tp1Pct),
    beAtPct: Number(beAtPct),
    openRiskPct: Number(openRiskPct.toFixed(3)),
    isOpen: true,
    notes: ""
  };

  port.positions = positions.concat([pos]);
  port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), Number(port.currentBalance ?? 0));
  writeJson(FILE_PORTFOLIO, port);

  appendTrade({ type:"OPEN", ...pos });
  return port;
}

function closePosition({ id, exitPrice }){
  ensurePortfolio();
  const port = readJsonSafe(FILE_PORTFOLIO, null);
  if(!port) throw new Error("portfolio.json unreadable");

  const price = Number(exitPrice);
  if(!Number.isFinite(price) || price<=0) throw new Error("exitPrice ongeldig");

  const positions = Array.isArray(port.positions) ? port.positions : [];
  const idx = positions.findIndex(p=>p.id===id && p.isOpen);
  if(idx<0) throw new Error("Open positie niet gevonden");

  const p = positions[idx];
  const entry = Number(p.entryPrice);
  const dir = (p.side==="BULL") ? 1 : -1;

  const pnlPct = ((price-entry)/entry)*100*dir;
  const impactPct = (Number(p.sizePct) * pnlPct) / 100;

  const cur = Number(port.currentBalance ?? 0);
  const newBal = cur * (1 + impactPct/100);

  positions[idx] = {
    ...p,
    tsClose: new Date().toISOString(),
    exitPrice: price,
    pnlPct: Number(pnlPct.toFixed(3)),
    accountImpactPct: Number(impactPct.toFixed(3)),
    isOpen: false
  };

  port.positions = positions;
  port.currentBalance = Number(newBal.toFixed(2));
  port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), port.currentBalance);

  writeJson(FILE_PORTFOLIO, port);
  appendTrade({ type:"CLOSE", id, symbol:p.symbol, side:p.side, engine:p.engine, entryPrice:entry, exitPrice:price, pnlPct:Number(pnlPct.toFixed(3)), accountImpactPct:Number(impactPct.toFixed(3)), ts:new Date().toISOString() });

  return port;
}

const server = http.createServer(async (req,res)=>{
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  if(pathname === "/api/bull"){
    const b = readFileSafe(FILE_BULL);
    return send(res, b?200:404, b?b:Buffer.from("{}"), "application/json");
  }
  if(pathname === "/api/bear"){
    const b = readFileSafe(FILE_BEAR);
    return send(res, b?200:404, b?b:Buffer.from("{}"), "application/json");
  }
  if(pathname === "/api/portfolio"){
    ensurePortfolio();
    const p = readFileSafe(FILE_PORTFOLIO);
    return send(res, 200, p||Buffer.from("{}"), "application/json");
  }
  if(pathname === "/api/trades"){
    ensurePortfolio();
    const t = readFileSafe(FILE_TRADES);
    return send(res, 200, t||Buffer.from(""), "text/plain");
  }

  if(pathname === "/api/action" && req.method === "POST"){
    ensurePortfolio();
    const raw = await readBody(req);
    let body = {};
    try{ body = JSON.parse(raw||"{}"); }catch{ return send(res,400,"Bad JSON"); }

    try{
      if(body.action==="OPEN"){
        const port = openPosition(body);
        return send(res, 200, Buffer.from(JSON.stringify({ ok:true, portfolio:port })), "application/json");
      }
      if(body.action==="CLOSE"){
        const port = closePosition(body);
        return send(res, 200, Buffer.from(JSON.stringify({ ok:true, portfolio:port })), "application/json");
      }
      if(body.action==="SET_BALANCE"){
        const port = readJsonSafe(FILE_PORTFOLIO, null);
        const b = Number(body.currentBalance);
        if(!Number.isFinite(b) || b<=0) throw new Error("balance ongeldig");
        port.currentBalance = Number(b.toFixed(2));
        port.peakBalance = Math.max(Number(port.peakBalance ?? b), port.currentBalance);
        writeJson(FILE_PORTFOLIO, port);
        return send(res, 200, Buffer.from(JSON.stringify({ ok:true, portfolio:port })), "application/json");
      }
      return send(res, 400, "Unknown action");
    }catch(e){
      return send(res, 400, Buffer.from(JSON.stringify({ ok:false, error: String(e.message||e) })), "application/json");
    }
  }

  // ✅ SPA routes: /bull en /bear ook naar index.html
  if(pathname === "/bull" || pathname === "/bear"){
    const b = readFileSafe(path.join(PUBLIC_DIR, "index.html"));
    return send(res, b?200:404, b?b:Buffer.from("Not found"), "text/html");
  }

  // Static
  let filePath = (pathname==="/") ? "/index.html" : pathname;
  filePath = path.join(PUBLIC_DIR, filePath);

  const ext = path.extname(filePath).toLowerCase();
  const type =
    ext===".html" ? "text/html" :
    ext===".css"  ? "text/css" :
    ext===".js"   ? "text/javascript" :
    "application/octet-stream";

  const b = readFileSafe(filePath);
  if(!b) return send(res, 404, "Not found");
  return send(res, 200, b, type);
});

server.listen(PORT, ()=> console.log(`✅ Server running: http://localhost:${PORT}`));
EOS

# -----------------------
# 2) scan.js patch: % tradePlan + ALLOW/SUPPRESS gate (portfolio)
# -----------------------
SCAN="cryptocroc-terminal/scanner/scan.js"
cp "$SCAN" "$SCAN.bak_$(date +%s)" || true

node - <<'NODE'
import fs from "fs";

const p = "cryptocroc-terminal/scanner/scan.js";
let s = fs.readFileSync(p,"utf8");

// A) tradeManagementPlanPct toevoegen/vervangen
if(!s.includes("function tradeManagementPlanPct(engine)")){
  // zoek plek om in te voegen: na sizingPlan of na tradeManagementPlan
  const anchor = "function sizingPlan(engine, exp){";
  const idx = s.indexOf(anchor);
  if(idx === -1) throw new Error("Kan sizingPlan() niet vinden om tradeManagementPlanPct naast te zetten.");

  // zet na sizingPlan blok (simpel: voeg toe ná de eerste volgende '}\n' na sizingPlan)
  const endIdx = s.indexOf("}\n", idx);
  if(endIdx === -1) throw new Error("Kan einde van sizingPlan() niet vinden.");

  const insertPos = endIdx + 2;

  const fn = `
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
`;
  s = s.slice(0,insertPos) + fn + s.slice(insertPos);
}

// B) portfolio inlezen in run() (eenmalig) + helpers
if(!s.includes("function ddPct(port){") || !s.includes("function openCounts(port){")){
  const marker = "async function run(){";
  const idx = s.indexOf(marker);
  if(idx === -1) throw new Error("Kan run() niet vinden.");

  // inject direct na begin run()
  const injectAt = s.indexOf("{", idx) + 1;

  const add = `
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
`;
  s = s.slice(0,injectAt) + add + s.slice(injectAt);
}

// C) ENTRY blok aanpassen: row.risk gate + row.tradePlan in %
if(!s.includes("gateReason")){
  // we zoeken de plek waar je nu exp/sp wordt gezet (expectancyProxy + sizingPlan)
  // en vervangen dat stuk netjes met gate+plan.
  const needle = "const exp = expectancyProxy(row);";
  const i = s.indexOf(needle);
  if(i === -1) throw new Error("Kan ENTRY expectancy blok niet vinden (const exp = expectancyProxy(row);).");

  // pak een stuk vanaf exp tot en met 'row.tradePlan ='
  const start = i;
  const end = s.indexOf("memAll[key]=mem;", i);
  if(end === -1) throw new Error("Kan einde ENTRY-sectie niet vinden (memAll[key]=mem;).");

  const chunk = s.slice(start, end);

  if(!chunk.includes("row.risk") || !chunk.includes("row.tradePlan")) {
    throw new Error("ENTRY-sectie lijkt anders dan verwacht (row.risk/row.tradePlan missen).");
  }

  // we vervangen alleen het risk/plan gedeelte binnen ENTRY success pad:
  // Zoek de eerste 'const exp...' tot en met 'row.tradePlan = ...;'
  const cEnd = chunk.indexOf("row.tradePlan");
  const lineEnd = chunk.indexOf(";", cEnd);
  const replaceTo = lineEnd + 2;

  const before = chunk.slice(0, 0);
  const after = chunk.slice(replaceTo);

  const replacement = `
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
    gateReason = \`DD kill switch (\${dd.toFixed(2)}% <= \${maxDD}%)\`;
  }

  const maxTotal = Number(portfolio.maxTotalOpenRiskPct ?? 4);
  const addOpenRisk = (Number(sp.suggestedSizePct) * Math.abs(Number(plan.stopPct))) / 100;

  if(gate==="ALLOW" && (c.openRiskPct + addOpenRisk) > maxTotal){
    gate = "SUPPRESS";
    gateReason = \`Max open risk (\${(c.openRiskPct+addOpenRisk).toFixed(2)}% > \${maxTotal}%)\`;
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
`;

  const newChunk = replacement + after;
  s = s.slice(0, start) + newChunk + s.slice(end);
}

fs.writeFileSync(p, s, "utf8");
console.log("scan.js patched ✅");
NODE

echo "✅ Klaar. Start opnieuw:"
echo "1) Ctrl+C (als server nog draait)"
echo "2) npm run scan"
echo "3) npm start"
echo ""
echo "Open daarna:"
echo "http://localhost:3000/#bull  (beste)"
echo "http://localhost:3000/#bear"
echo "en nu werkt ook /bull en /bear"
