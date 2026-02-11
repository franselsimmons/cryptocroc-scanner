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
