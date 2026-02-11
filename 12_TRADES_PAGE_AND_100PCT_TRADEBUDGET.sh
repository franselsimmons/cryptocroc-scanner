#!/usr/bin/env bash
set -e

echo "== Add Trades page + make sizing clearly % of 100% trade-budget =="

# -----------------------
# 1) server.mjs: route /trades -> trades.html (net als /bull /bear)
# -----------------------
# We patchen heel gericht: als /trades niet bestaat, voegen we toe.
node - <<'NODE'
import fs from "fs";

const p="server.mjs";
let s=fs.readFileSync(p,"utf8");

if(!s.includes('pathname === "/trades"')){
  // Voeg block toe vlak vóór // Static
  const marker = "\n  // Static\n";
  const i = s.indexOf(marker);
  if(i<0) throw new Error("Kan '// Static' niet vinden in server.mjs");

  const add = `
  // ✅ Trades page route
  if(pathname === "/trades" || pathname === "/trades/"){
    const b = readFileSafe(path.join(PUBLIC_DIR, "trades.html"));
    return send(res, b?200:404, b?b:Buffer.from("Not found"), "text/html");
  }
`;
  s = s.slice(0,i) + add + s.slice(i);
  fs.writeFileSync(p,s,"utf8");
  console.log("server.mjs patched ✅");
} else {
  console.log("server.mjs already has /trades route ✅");
}
NODE

# -----------------------
# 2) public/index.html: knop "TRADES"
# -----------------------
node - <<'NODE'
import fs from "fs";
const p="public/index.html";
let s=fs.readFileSync(p,"utf8");

// voeg knop toe in tabs (naast Refresh)
if(!s.includes('id="btnTrades"')){
  s = s.replace(
    '<button id="btnRefresh" class="ghost">Refresh</button>',
    '<button id="btnRefresh" class="ghost">Refresh</button>\n      <button id="btnTrades" class="ghost">Trades</button>'
  );
  fs.writeFileSync(p,s,"utf8");
  console.log("index.html patched ✅");
} else {
  console.log("index.html already ok ✅");
}
NODE

# -----------------------
# 3) public/app.js: Trades knop + duidelijk: size% is % van 100% trade-budget
# -----------------------
node - <<'NODE'
import fs from "fs";
const p="public/app.js";
let s=fs.readFileSync(p,"utf8");

// Trades knop handler
if(!s.includes('$("#btnTrades")')){
  s = s.replace(
    '$("#btnRefresh").onclick = ()=>load();',
    '$("#btnRefresh").onclick = ()=>load();\n$("#btnTrades").onclick = ()=>{ location.href = "/trades"; };'
  );
}

// Popup tekst iets duidelijker (trade-budget = 100%)
s = s.replace(
  '["Suggested size", (r?.risk?.suggestedSizePct!=null? r.risk.suggestedSizePct+"%":"—"), "Hoeveel % van je trade-budget je gebruikt."],',
  '["Inzet advies", (r?.risk?.suggestedSizePct!=null? r.risk.suggestedSizePct+"%":"—"), "Dit is % van jouw 100% trade-budget per trade (A=100%, B=80/90%, C=50/60%)."],'
);

// tabel header "Size" -> "Inzet"
s = s.replaceAll("<th>Size</th>", "<th>Inzet</th>");

fs.writeFileSync(p,s,"utf8");
console.log("app.js patched ✅");
NODE

# -----------------------
# 4) Trades page files
# -----------------------
cat << 'EOT' > public/trades.html
<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>CryptoCroc • Trades</title>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body>
  <header class="top">
    <div class="brand">
      <div class="logo">🐊</div>
      <div>
        <div class="title">CryptoCroc • Trades</div>
        <div class="sub">Winrate • avg% • expectancy per engine • laatste trades</div>
      </div>
    </div>

    <div class="tabs">
      <button id="btnBack" class="tab active">Back</button>
      <button id="btnReload" class="ghost">Reload</button>
    </div>

    <div class="status">
      <div id="sumAll" class="pill">loading…</div>
      <div id="sumExp" class="pill">EXPLOSIE…</div>
      <div id="sumAcc" class="pill">ACCUMULATIE…</div>
    </div>
  </header>

  <main class="wrap">
    <div class="block">
      <div class="blockHead">
        <div class="blockTitle">Open posities</div>
        <div class="blockHint">Wat nu open staat (uit portfolio.json)</div>
      </div>
      <table class="table" id="openTable">
        <thead>
          <tr>
            <th>Symbol</th><th>Side</th><th>Engine</th><th>Entry</th><th>Inzet</th><th>Stop</th><th>Open risk</th><th>Open sinds</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>

    <div class="block">
      <div class="blockHead">
        <div class="blockTitle">Trades (gesloten)</div>
        <div class="blockHint">Pnl% = prijsbeweging (long/short). Impact% = effect op je account (size% * pnl%).</div>
      </div>

      <div style="padding:12px 14px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
        <span class="badge">Filter</span>
        <button class="ghost" id="fAll">ALL</button>
        <button class="ghost" id="fExp">EXPLOSIE</button>
        <button class="ghost" id="fAcc">ACCUMULATIE</button>
        <span class="badge" id="countShown">…</span>
      </div>

      <table class="table" id="trTable">
        <thead>
          <tr>
            <th>Close time</th><th>Symbol</th><th>Side</th><th>Engine</th><th>Entry</th><th>Exit</th><th>Pnl%</th><th>Impact%</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </main>

  <script src="/trades.js"></script>
</body>
</html>
EOT

cat << 'EOJ' > public/trades.js
const API = { trades:"/api/trades", portfolio:"/api/portfolio" };

const $ = (s)=>document.querySelector(s);
const tbOpen = $("#openTable tbody");
const tb = $("#trTable tbody");

let FILTER = "ALL";
let CLOSED = [];

$("#btnBack").onclick = ()=>{ location.href="/#bull"; };
$("#btnReload").onclick = ()=>load();

$("#fAll").onclick = ()=>{ FILTER="ALL"; render(); };
$("#fExp").onclick = ()=>{ FILTER="EXPLOSIE"; render(); };
$("#fAcc").onclick = ()=>{ FILTER="ACCUMULATIE"; render(); };

function fmt(x){
  if(x==null || !Number.isFinite(x)) return "—";
  const abs = Math.abs(x);
  if(abs >= 1e9) return (x/1e9).toFixed(2)+"B";
  if(abs >= 1e6) return (x/1e6).toFixed(2)+"M";
  if(abs >= 1e3) return (x/1e3).toFixed(2)+"K";
  return x.toFixed(6);
}
function pct(x){
  if(x==null || !Number.isFinite(x)) return "—";
  return (x>=0?"+":"") + x.toFixed(2) + "%";
}
function cls(x){
  if(x==null || !Number.isFinite(x)) return "";
  return x>=0 ? "good" : "bad";
}

function stats(rows){
  const n = rows.length;
  if(n===0) return { n:0, win:0, winrate:0, avgPnl:0, avgImpact:0, expectancy:0 };
  const wins = rows.filter(r=> (r.accountImpactPct ?? 0) > 0).length;
  const avgPnl = rows.reduce((s,r)=> s+(Number(r.pnlPct)||0),0)/n;
  const avgImpact = rows.reduce((s,r)=> s+(Number(r.accountImpactPct)||0),0)/n;

  // expectancy (simpel & eerlijk): gemiddelde accountImpact% per trade
  const expectancy = avgImpact;

  return {
    n,
    win: wins,
    winrate: (wins/n)*100,
    avgPnl,
    avgImpact,
    expectancy
  };
}

async function load(){
  // open posities
  tbOpen.innerHTML = "";
  try{
    const r = await fetch(API.portfolio, { cache:"no-store" });
    const p = await r.json();
    const open = (p.positions||[]).filter(x=>x.isOpen);

    for(const o of open){
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="badge">${o.symbol}</span></td>
        <td>${o.side}</td>
        <td><span class="badge">${o.engine}</span></td>
        <td>${fmt(o.entryPrice)}</td>
        <td><span class="badge">${o.sizePct}%</span></td>
        <td>${pct(o.stopPct)}</td>
        <td><span class="badge">${(o.openRiskPct!=null? o.openRiskPct.toFixed(2):"—")}%</span></td>
        <td>${o.tsOpen || "—"}</td>
      `;
      tbOpen.appendChild(tr);
    }
    if(open.length===0){
      const tr = document.createElement("tr");
      tr.innerHTML = `<td colspan="8" style="color:var(--muted)">Geen open posities</td>`;
      tbOpen.appendChild(tr);
    }
  }catch{
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" style="color:var(--muted)">Portfolio niet leesbaar</td>`;
    tbOpen.appendChild(tr);
  }

  // trades.jsonl (CLOSE regels)
  let raw = "";
  try{
    const r = await fetch(API.trades, { cache:"no-store" });
    raw = await r.text();
  }catch{
    raw = "";
  }

  const lines = raw.split("\n").map(x=>x.trim()).filter(Boolean);
  const parsed = [];
  for(const line of lines){
    try{
      const j = JSON.parse(line);
      if(j.type==="CLOSE") parsed.push(j);
    }catch{}
  }

  // nieuwste boven
  parsed.sort((a,b)=> String(b.ts||"").localeCompare(String(a.ts||"")));
  CLOSED = parsed.slice(0, 400); // max 400 tonen

  render();
}

function render(){
  const rows = CLOSED.filter(r=>{
    if(FILTER==="ALL") return true;
    return r.engine === FILTER;
  });

  const all = stats(CLOSED);
  const exp = stats(CLOSED.filter(r=>r.engine==="EXPLOSIE"));
  const acc = stats(CLOSED.filter(r=>r.engine==="ACCUMULATIE"));

  $("#sumAll").textContent = `ALL: ${all.n} | win ${all.winrate.toFixed(1)}% | avg impact ${all.avgImpact.toFixed(2)}% | exp ${all.expectancy.toFixed(2)}%`;
  $("#sumExp").textContent = `EXPLOSIE: ${exp.n} | win ${exp.winrate.toFixed(1)}% | avg impact ${exp.avgImpact.toFixed(2)}%`;
  $("#sumAcc").textContent = `ACCUMULATIE: ${acc.n} | win ${acc.winrate.toFixed(1)}% | avg impact ${acc.avgImpact.toFixed(2)}%`;

  $("#countShown").textContent = `shown: ${rows.length}`;

  tb.innerHTML = "";
  if(rows.length===0){
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="8" style="color:var(--muted)">Nog geen gesloten trades (of filter leeg)</td>`;
    tb.appendChild(tr);
    return;
  }

  for(const r of rows){
    const tr = document.createElement("tr");
    const pnl = Number(r.pnlPct);
    const imp = Number(r.accountImpactPct);

    tr.innerHTML = `
      <td>${r.ts || "—"}</td>
      <td><span class="badge">${r.symbol || "—"}</span></td>
      <td>${r.side || "—"}</td>
      <td><span class="badge">${r.engine || "—"}</span></td>
      <td>${fmt(Number(r.entryPrice))}</td>
      <td>${fmt(Number(r.exitPrice))}</td>
      <td class="${cls(pnl)}">${pct(pnl)}</td>
      <td class="${cls(imp)}">${pct(imp)}</td>
    `;
    tb.appendChild(tr);
  }
}

load();
EOJ

echo "✅ Trades page installed"
echo "➡️ Restart je server:"
echo "   Ctrl+C"
echo "   npm run scan"
echo "   npm start"
echo ""
echo "Open:"
echo "  http://localhost:3000/#bull"
echo "  http://localhost:3000/trades"
