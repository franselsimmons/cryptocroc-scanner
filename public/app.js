async function apiGet(url){
  const r = await fetch(url, { cache: "no-store" });
  return await r.json();
}

function el(id){ return document.getElementById(id); }

function fmt(n, d=2){
  if (n === null || n === undefined) return "-";
  const x = Number(n);
  if (!Number.isFinite(x)) return "-";
  return x.toFixed(d);
}

function rowHtml(x){
  const ob = x.ob;
  const obTxt = ob ? `${ob.src} | imbal:${fmt(ob.imbalance,3)} | spr:${fmt(ob.spread,6)}` : (ob===null ? "no ob" : "-");
  return `
    <tr>
      <td>${x.symbol}</td>
      <td>${x.name}</td>
      <td>${fmt(x.price,6)}</td>
      <td>${fmt(x.ch1h,2)}%</td>
      <td>${fmt(x.ch24,2)}%</td>
      <td>${fmt(x.ch7d,2)}%</td>
      <td>${fmt(x.vm,4)}</td>
      <td>${obTxt}</td>
    </tr>
  `;
}

function renderTable(tblId, arr){
  el(tblId).innerHTML = arr.map(rowHtml).join("");
}

async function load(side){
  el("status").textContent = "laden...";
  const d = await apiGet(`/api/data?side=${side}`);
  if (!d.ok){
    el("status").textContent = d.error || "error";
    return;
  }
  const t = d.out?.tables || {};
  renderTable("RADAR",   t.RADAR||[]);
  renderTable("BUILDUP", t.BUILDUP||[]);
  renderTable("ALMOST",  t.ALMOST||[]);
  renderTable("ENTRY",   t.ENTRY||[]);
  renderTable("HOLD",    t.HOLD||[]);
  renderTable("SELL",    t.SELL||[]);
  el("status").textContent = `ok | ${new Date(d.out.t).toLocaleString()}`;
}

async function scan(side){
  el("status").textContent = "scannen...";
  const d = await apiGet(`/api/scan?side=${side}`);
  if (!d.ok){
    el("status").textContent = d.error || "scan error";
    return;
  }
  await load(side);
}

window.CC = { load, scan };
