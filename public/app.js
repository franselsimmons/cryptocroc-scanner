const qs = (s, el=document) => el.querySelector(s);
const qsa = (s, el=document) => [...el.querySelectorAll(s)];

const funnelOrder = [
  "SELL",
  "HOLD",
  "ENTRY",
  "ALMOST",
  "BUILDUP",
  "RADAR"
]; // ENTRY boven, RADAR onder (SELL/HOLD helemaal boven)

function fmt(n, d=2){
  if(n === null || n === undefined || Number.isNaN(n)) return "-";
  const x = Number(n);
  return x.toFixed(d);
}

function pct(n, d=2){
  if(n === null || n === undefined || Number.isNaN(n)) return "-";
  const x = Number(n);
  return (x>=0?"+":"") + x.toFixed(d) + "%";
}

function badgeStage(stage){
  const s = (stage||"").toUpperCase();
  if(["HOLD","ENTRY"].includes(s)) return `<span class="badge good">${s}</span>`;
  if(["ALMOST","BUILDUP"].includes(s)) return `<span class="badge warn">${s}</span>`;
  if(["SELL"].includes(s)) return `<span class="badge bad">${s}</span>`;
  return `<span class="badge">${s||"-"}</span>`;
}

// Orderbook UI: verwacht velden zoals ob (object) of orderbook (object).
// We tonen dit alleen bij ALMOST/ENTRY/HOLD/SELL.
function renderOB(coin){
  const stage = (coin.stage || coin.funnel || "").toUpperCase();
  const show = ["ALMOST","ENTRY","HOLD","SELL"].includes(stage);
  if(!show) return `<span class="small">OB: -</span>`;

  const ob = coin.ob || coin.orderbook || null;
  if(!ob) return `<span class="small">OB: (geen data)</span>`;

  const bid = ob.bidImb ?? ob.bid_imb ?? ob.bid ?? null;
  const ask = ob.askImb ?? ob.ask_imb ?? ob.ask ?? null;
  const imb = ob.imbalance ?? ob.imb ?? null;
  const spr = ob.spreadPct ?? ob.spread_pct ?? ob.spread ?? null;

  return `
    <div class="ob">
      <div class="box"><div class="small">Imbalance</div><div><b>${fmt(imb,3)}</b></div></div>
      <div class="box"><div class="small">Bid strength</div><div><b>${fmt(bid,3)}</b></div></div>
      <div class="box"><div class="small">Ask strength</div><div><b>${fmt(ask,3)}</b></div></div>
      <div class="box"><div class="small">Spread</div><div><b>${fmt(spr,3)}%</b></div></div>
    </div>
  `;
}

function rowHtml(c){
  return `
    <tr>
      <td class="sym">${c.symbol || c.sym || "-"}</td>
      <td>${badgeStage(c.stage || c.funnel)}</td>
      <td>${pct(c.ch1h ?? c.pct1h ?? c.p1h)}</td>
      <td>${pct(c.ch24 ?? c.pct24 ?? c.p24)}</td>
      <td>${fmt(c.vm ?? c.vmRatio ?? c.vm_ratio, 3)}</td>
      <td>${fmt(c.range ?? c.rangePct ?? c.range_pct, 2)}%</td>
      <td>${fmt(c.score ?? c.score100 ?? c.s, 1)}</td>
      <td>${renderOB(c)}</td>
    </tr>
  `;
}

function normalizeData(raw){
  // Ondersteun verschillende API outputs:
  // - { ok:true, data:{ RADAR:[], BUILDUP:[], ... } }
  // - { ok:true, funnel:{ ... } }
  // - { ok:true, coins:[...] } (met stage per coin)
  // - direct array
  if(Array.isArray(raw)) return { buckets: { ALL: raw } };

  const obj = raw?.data ?? raw ?? {};
  const buckets = obj.funnel ?? obj.buckets ?? obj.stages ?? obj;
  // Als buckets al stage arrays heeft:
  const hasStages = buckets && funnelOrder.some(k => Array.isArray(buckets[k]));
  if(hasStages) return { buckets };

  const coins = obj.coins ?? obj.items ?? obj.list ?? [];
  if(Array.isArray(coins)){
    // bucket per coin.stage
    const out = {};
    for(const c of coins){
      const st = (c.stage || c.funnel || "RADAR").toUpperCase();
      out[st] = out[st] || [];
      out[st].push(c);
    }
    return { buckets: out };
  }

  return { buckets: { RADAR: [] } };
}

async function load(side){
  const api = side === "bear" ? "/api/top10_bear" : "/api/top10";
  qs("#sideLabel").textContent = side.toUpperCase();

  qs("#error").style.display="none";
  qs("#error").textContent="";

  const t0 = Date.now();
  const res = await fetch(api, { cache:"no-store" });
  const json = await res.json().catch(()=> ({}));
  const ms = Date.now()-t0;

  if(!res.ok || json.ok === false){
    qs("#error").style.display="block";
    qs("#error").textContent = JSON.stringify(json, null, 2);
    qs("#meta").innerHTML = `<span class="chip">API: ${api}</span><span class="chip">status: ${res.status}</span><span class="chip">${ms}ms</span>`;
    qs("#content").innerHTML = "";
    return;
  }

  const { buckets } = normalizeData(json);
  const next = json.nextScanIn ?? json.next ?? json.next_scan_in ?? null;

  qs("#meta").innerHTML = `
    <span class="chip">API: ${api}</span>
    <span class="chip">laadtijd: ${ms}ms</span>
    ${next ? `<span class="chip">next: ${next}s</span>` : ``}
  `;

  const sections = [];
  for(const stage of funnelOrder){
    const arr = Array.isArray(buckets[stage]) ? buckets[stage] : [];
    sections.push(`
      <div class="panel">
        <div class="panelHead">
          <h2>${stage} <span class="count">(${arr.length})</span></h2>
          <div class="small">ENTRY boven / RADAR onder</div>
        </div>
        <div class="tableWrap">
          <table>
            <thead>
              <tr>
                <th>COIN</th>
                <th>STAGE</th>
                <th>1H</th>
                <th>24H</th>
                <th>VM</th>
                <th>RANGE</th>
                <th>SCORE</th>
                <th>ORDERBOOK</th>
              </tr>
            </thead>
            <tbody>
              ${arr.map(rowHtml).join("") || `<tr><td colspan="8" class="small">Geen coins in ${stage}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>
    `);
  }

  qs("#content").innerHTML = sections.join("");
}

async function scanNow(){
  // Als je API een /api/scan endpoint heeft met secret, laten we het hier simpel:
  // we herladen alleen (jij hebt ook een knop “Scan nu”).
  const side = qs("#btnBear").classList.contains("active") ? "bear" : "bull";
  await load(side);
}

function setActive(side){
  const b1 = qs("#btnBull");
  const b2 = qs("#btnBear");
  b1.classList.toggle("active", side==="bull");
  b2.classList.toggle("active", side==="bear");
}

window.addEventListener("DOMContentLoaded", async () => {
  qs("#btnBull").addEventListener("click", async ()=>{ setActive("bull"); await load("bull"); });
  qs("#btnBear").addEventListener("click", async ()=>{ setActive("bear"); await load("bear"); });
  qs("#btnScan").addEventListener("click", scanNow);

  setActive("bull");
  await load("bull");
});
