#!/usr/bin/env bash
set -euo pipefail

mkdir -p public

# =========================
# public/index.html
# =========================
cat > public/index.html << 'HTML'
<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>CryptoCroc Scanner</title>
  <link rel="stylesheet" href="/app.css" />
</head>
<body>
  <div class="bg"></div>

  <header class="top">
    <div class="brand">
      <div class="logo">🐊</div>
      <div>
        <div class="title">CryptoCroc Scanner</div>
        <div class="sub">BULL/BEAR • trechter • orderbook</div>
      </div>
    </div>

    <div class="controls">
      <div class="seg">
        <button id="btnBull" class="seg-btn is-on">BULL</button>
        <button id="btnBear" class="seg-btn">BEAR</button>
      </div>

      <button id="btnScan" class="btn btn-primary">Scan nu</button>
      <button id="btnRefresh" class="btn">↻</button>

      <input id="search" class="search" placeholder="Zoek coin… (bijv. PEPE)" />

      <div class="chips">
        <span class="chip" id="chipApi">API: …</span>
        <span class="chip" id="chipStatus">status: …</span>
        <span class="chip" id="chipMs">…ms</span>
        <span class="chip" id="chipLast">last scan: —</span>
      </div>
    </div>
  </header>

  <main class="wrap">
    <!-- Loader balk (gaat altijd weg door JS) -->
    <div id="loader" class="loader is-hidden">
      <div class="loader-bar"></div>
      <div class="loader-text" id="loaderText">Bezig met laden…</div>
    </div>

    <!-- Error box -->
    <div id="errorBox" class="error is-hidden"></div>

    <!-- Orderbook panel -->
    <section class="panel">
      <div class="panel-h">
        <div class="panel-title">Orderbook</div>
        <div class="panel-sub" id="obHint">Wordt alleen getoond bij ALMOST/ENTRY/HOLD/SELL (als API OB levert).</div>
      </div>
      <div id="orderbook" class="ob"></div>
    </section>

    <!-- Funnel -->
    <section class="grid" id="grid"></section>

    <footer class="foot">
      <span>Tip: klik op een coin voor details + orderbook.</span>
    </footer>
  </main>

  <script src="/app.js"></script>
</body>
</html>
HTML

# =========================
# public/app.css
# =========================
cat > public/app.css << 'CSS'
:root{
  --bg1:#071018;
  --bg2:#071b14;
  --card:#0c1620cc;
  --card2:#0b1420e6;
  --stroke:#1e2a37;
  --text:#e7f0ff;
  --muted:#9fb0c7;
  --good:#33d17a;
  --warn:#ffb86b;
  --bad:#ff5c7a;
  --blue:#64b5ff;
  --shadow:0 20px 60px rgba(0,0,0,.45);
}

*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
  color:var(--text);
  background:linear-gradient(180deg,var(--bg1),var(--bg2));
}

.bg{
  position:fixed; inset:0;
  background:
    radial-gradient(1200px 600px at 10% 20%, rgba(51,209,122,.18), transparent 60%),
    radial-gradient(900px 500px at 70% 40%, rgba(100,181,255,.16), transparent 55%),
    radial-gradient(900px 700px at 40% 90%, rgba(255,92,122,.10), transparent 60%);
  pointer-events:none;
}

.top{
  position:sticky; top:0; z-index:10;
  display:flex; gap:16px; align-items:center; justify-content:space-between;
  padding:14px 16px;
  background:linear-gradient(180deg, rgba(6,12,18,.85), rgba(6,12,18,.55));
  border-bottom:1px solid rgba(30,42,55,.7);
  backdrop-filter: blur(10px);
}

.brand{display:flex; gap:10px; align-items:center}
.logo{
  width:42px; height:42px; border-radius:12px;
  display:grid; place-items:center;
  background:linear-gradient(135deg, rgba(51,209,122,.25), rgba(100,181,255,.15));
  border:1px solid rgba(30,42,55,.9);
  box-shadow: var(--shadow);
}
.title{font-weight:800; letter-spacing:.2px}
.sub{font-size:12px; color:var(--muted); margin-top:2px}

.controls{display:flex; gap:10px; align-items:center; flex-wrap:wrap; justify-content:flex-end}

.seg{
  display:flex; border:1px solid rgba(30,42,55,.9);
  border-radius:14px; overflow:hidden;
  background:rgba(10,18,28,.55);
}
.seg-btn{
  padding:10px 14px; border:0; background:transparent;
  color:var(--muted); cursor:pointer; font-weight:700;
}
.seg-btn.is-on{color:var(--text); background:rgba(100,181,255,.14)}

.btn{
  padding:10px 12px;
  border-radius:12px;
  border:1px solid rgba(30,42,55,.9);
  background:rgba(10,18,28,.55);
  color:var(--text);
  cursor:pointer;
}
.btn:hover{transform: translateY(-1px)}
.btn-primary{
  background:linear-gradient(135deg, rgba(51,209,122,.22), rgba(100,181,255,.16));
  border-color: rgba(51,209,122,.35);
  font-weight:800;
}

.search{
  min-width:220px;
  padding:10px 12px;
  border-radius:12px;
  border:1px solid rgba(30,42,55,.9);
  background:rgba(10,18,28,.55);
  color:var(--text);
  outline:none;
}
.search::placeholder{color:rgba(159,176,199,.75)}

.chips{display:flex; gap:8px; flex-wrap:wrap}
.chip{
  font-size:12px; color:var(--muted);
  padding:6px 10px; border-radius:999px;
  border:1px solid rgba(30,42,55,.85);
  background:rgba(10,18,28,.45);
}

.wrap{max-width:1200px; margin:0 auto; padding:18px 16px 40px}

.loader{
  position:relative;
  border:1px solid rgba(30,42,55,.9);
  background:rgba(10,18,28,.55);
  border-radius:14px;
  padding:14px;
  margin-bottom:14px;
  overflow:hidden;
}
.loader.is-hidden{display:none}
.loader-bar{
  position:absolute; left:-35%; top:0; bottom:0;
  width:35%;
  background:linear-gradient(90deg, transparent, rgba(100,181,255,.25), rgba(51,209,122,.22), transparent);
  animation: slide 1.0s linear infinite;
}
@keyframes slide{to{left:100%}}
.loader-text{position:relative; z-index:1; color:var(--muted); font-weight:700}

.error{
  border:1px solid rgba(255,92,122,.35);
  background:rgba(255,92,122,.10);
  color:#ffd7df;
  padding:12px 14px;
  border-radius:14px;
  margin-bottom:14px;
}
.error.is-hidden{display:none}

.panel{
  border:1px solid rgba(30,42,55,.9);
  background:rgba(12,22,32,.55);
  border-radius:16px;
  box-shadow: var(--shadow);
  margin-bottom:16px;
}
.panel-h{
  display:flex; justify-content:space-between; align-items:baseline;
  padding:14px 14px 10px 14px;
  border-bottom:1px solid rgba(30,42,55,.7);
}
.panel-title{font-weight:900}
.panel-sub{font-size:12px; color:var(--muted)}
.ob{padding:12px 14px}
.ob-empty{color:var(--muted); font-size:13px}
.ob-grid{
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap:12px;
}
.ob-box{
  border:1px solid rgba(30,42,55,.8);
  border-radius:14px;
  background:rgba(10,18,28,.40);
  padding:10px;
}
.ob-box h4{margin:0 0 8px 0; font-size:12px; color:var(--muted); font-weight:800; letter-spacing:.3px}
.ob-row{display:flex; justify-content:space-between; font-size:13px; padding:3px 0}
.ob-row b{color:var(--text)}
.pos{color:var(--good); font-weight:800}
.neg{color:var(--bad); font-weight:800}

.grid{
  display:grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap:14px;
}
@media (max-width: 900px){
  .grid{grid-template-columns:1fr}
}

.stage{
  border:1px solid rgba(30,42,55,.9);
  background:rgba(12,22,32,.55);
  border-radius:16px;
  box-shadow: var(--shadow);
  overflow:hidden;
}
.stage-h{
  display:flex; justify-content:space-between; align-items:center;
  padding:12px 14px;
  border-bottom:1px solid rgba(30,42,55,.7);
}
.stage-name{font-weight:1000; letter-spacing:.3px}
.stage-count{color:var(--muted); font-weight:800; font-size:12px}

.list{padding:10px 12px}
.item{
  display:flex; justify-content:space-between; align-items:flex-start;
  gap:12px;
  padding:10px 10px;
  border-radius:14px;
  border:1px solid rgba(30,42,55,.75);
  background:rgba(10,18,28,.40);
  cursor:pointer;
  margin-bottom:10px;
}
.item:hover{transform:translateY(-1px)}
.sym{font-weight:1000}
.meta{font-size:12px; color:var(--muted); margin-top:3px}
.badges{display:flex; gap:6px; flex-wrap:wrap; margin-top:6px}
.badge{
  font-size:11px; padding:4px 8px; border-radius:999px;
  border:1px solid rgba(30,42,55,.85);
  color:var(--muted);
  background:rgba(8,14,22,.45);
}
.badge.good{border-color: rgba(51,209,122,.35); color:#bff4d6}
.badge.warn{border-color: rgba(255,184,107,.35); color:#ffe6c7}
.badge.bad{border-color: rgba(255,92,122,.35); color:#ffd0da}

.right{
  text-align:right;
  min-width:160px;
}
.price{font-weight:900}
.pct{font-weight:900}
.pct.good{color:var(--good)}
.pct.bad{color:var(--bad)}

.foot{margin-top:16px; color:var(--muted); font-size:12px}
CSS

# =========================
# public/app.js
# =========================
cat > public/app.js << 'JS'
/**
 * CryptoCroc UI
 * - ENTRY boven, RADAR onder (vaste volgorde)
 * - Loader balk gaat ALTIJD weg (finally + timeout)
 * - Orderbook panel netjes
 */

const API = {
  bull: "/api/top10",
  bear: "/api/top10_bear"
};

let side = "bull";
let lastData = null;

const $ = (id) => document.getElementById(id);

const btnBull = $("btnBull");
const btnBear = $("btnBear");
const btnScan = $("btnScan");
const btnRefresh = $("btnRefresh");
const search = $("search");

const chipApi = $("chipApi");
const chipStatus = $("chipStatus");
const chipMs = $("chipMs");
const chipLast = $("chipLast");

const loader = $("loader");
const loaderText = $("loaderText");
const errorBox = $("errorBox");
const grid = $("grid");
const orderbook = $("orderbook");

function setSide(newSide){
  side = newSide;
  btnBull.classList.toggle("is-on", side === "bull");
  btnBear.classList.toggle("is-on", side === "bear");
  load(false);
}

function showLoader(text="Bezig met laden…"){
  loaderText.textContent = text;
  loader.classList.remove("is-hidden");
}
function hideLoader(){
  loader.classList.add("is-hidden");
}
function showError(msg){
  errorBox.textContent = msg;
  errorBox.classList.remove("is-hidden");
}
function clearError(){
  errorBox.classList.add("is-hidden");
  errorBox.textContent = "";
}

function fmtUsd(n){
  if(n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  if(v >= 1e9) return (v/1e9).toFixed(2) + "B";
  if(v >= 1e6) return (v/1e6).toFixed(2) + "M";
  if(v >= 1e3) return (v/1e3).toFixed(1) + "K";
  return v.toFixed(0);
}
function fmtNum(n, d=2){
  if(n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(d);
}
function pctClass(p){
  if(p == null) return "";
  return p >= 0 ? "good" : "bad";
}

/**
 * Fetch met timeout -> voorkomt "balk blijft hangen"
 */
async function fetchJson(url, timeoutMs=20000){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = performance.now();
  try{
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const ms = Math.round(performance.now() - t0);
    let data = null;
    try{ data = await res.json(); } catch(e){ /* ignore */ }
    return { ok: res.ok, status: res.status, ms, data };
  } finally {
    clearTimeout(t);
  }
}

function normalize(data){
  // We accepteren meerdere vormen:
  // 1) { ok:true, ts, side, funnel:{ENTRY:[],ALMOST:[],BUILDUP:[],RADAR:[],HOLD:[],SELL:[]}, meta:{...} }
  // 2) { ENTRY:[], ALMOST:[], ... }
  // 3) array -> treat as RADAR
  if(!data) return { funnel: emptyFunnel(), ts:null, meta:{} };

  if(Array.isArray(data)){
    return { funnel: { ...emptyFunnel(), RADAR: data }, ts: Date.now(), meta:{} };
  }

  if(data.funnel){
    return { funnel: mergeFunnel(data.funnel), ts: data.ts || Date.now(), meta: data.meta || {} };
  }

  const keys = ["ENTRY","HOLD","SELL","ALMOST","BUILDUP","RADAR"];
  const looksLikeStages = keys.some(k => Array.isArray(data[k]));
  if(looksLikeStages){
    const f = emptyFunnel();
    for(const k of keys){
      if(Array.isArray(data[k])) f[k] = data[k];
    }
    return { funnel: f, ts: data.ts || Date.now(), meta: data.meta || {} };
  }

  return { funnel: emptyFunnel(), ts: Date.now(), meta:{} };
}

function emptyFunnel(){
  return { ENTRY:[], HOLD:[], SELL:[], ALMOST:[], BUILDUP:[], RADAR:[] };
}
function mergeFunnel(f){
  const out = emptyFunnel();
  for(const k of Object.keys(out)){
    if(Array.isArray(f[k])) out[k] = f[k];
  }
  return out;
}

function stageOrder(){
  // ✅ ENTRY boven, RADAR onder
  return [
    { key:"ENTRY",  label:"ENTRY"  },
    { key:"HOLD",   label:"HOLD"   },
    { key:"SELL",   label:"SELL"   },
    { key:"ALMOST", label:"ALMOST" },
    { key:"BUILDUP",label:"BUILDUP"},
    { key:"RADAR",  label:"RADAR"  },
  ];
}

function coinMatchesSearch(c){
  const q = (search.value || "").trim().toUpperCase();
  if(!q) return true;
  const sym = String(c.symbol || c.sym || c.ticker || "").toUpperCase();
  const name = String(c.name || "").toUpperCase();
  return sym.includes(q) || name.includes(q);
}

function getSym(c){
  return (c.symbol || c.sym || c.ticker || "").toUpperCase();
}

function getBadges(c){
  // We tonen "filters" als badges als ze bestaan
  // We ondersteunen meerdere keys: filters[], flags[], pass[], reasons[], etc.
  const out = [];
  const add = (t, cls="") => out.push({ t, cls });

  if(c.vm != null) add("VM " + fmtNum(c.vm,2), c.vm >= 0.14 ? "good":"");
  if(c.vol != null) add("VOL " + fmtUsd(c.vol), c.vol >= 250000 ? "good":"");
  if(c.mcap != null) add("MCAP " + fmtUsd(c.mcap), "");
  if(c.range != null) add("RANGE " + fmtNum(c.range,1) + "%", "");
  if(c.ctl != null) add("CTL " + fmtNum(c.ctl,2), "");
  if(c.timingScore != null) add("TS " + c.timingScore, c.timingScore >= 3 ? "good":"");

  // pass/fail info
  if(c.passSide === true) add("SIDE OK", "good");
  if(c.passSide === false) add("SIDE FAIL", "bad");

  // any array style
  const arr = c.filters || c.flags || c.reasons || c.notes;
  if(Array.isArray(arr)){
    for(const x of arr.slice(0,6)){
      const s = String(x);
      if(!s) continue;
      let cls = "";
      if(s.toLowerCase().includes("fail")) cls = "bad";
      if(s.toLowerCase().includes("ok") || s.toLowerCase().includes("pass")) cls = "good";
      add(s, cls);
    }
  }

  return out.slice(0,10);
}

function render(){
  const n = normalize(lastData);
  const funnel = n.funnel;

  grid.innerHTML = "";
  const ordered = stageOrder();

  for(const st of ordered){
    const list = (funnel[st.key] || []).filter(coinMatchesSearch);

    const stageEl = document.createElement("div");
    stageEl.className = "stage";

    const h = document.createElement("div");
    h.className = "stage-h";
    h.innerHTML = `<div class="stage-name">${st.label}</div><div class="stage-count">${list.length} coins</div>`;
    stageEl.appendChild(h);

    const wrap = document.createElement("div");
    wrap.className = "list";

    if(list.length === 0){
      const empty = document.createElement("div");
      empty.className = "meta";
      empty.textContent = "Geen coins in deze stage.";
      wrap.appendChild(empty);
    } else {
      for(const c of list){
        const sym = getSym(c);
        const name = c.name ? String(c.name) : "";
        const price = c.price ?? c.last ?? null;
        const ch24 = c.ch24 ?? c.change24 ?? c.pct24 ?? null;

        const item = document.createElement("div");
        item.className = "item";
        item.onclick = () => selectCoin(st.key, c);

        const left = document.createElement("div");
        left.innerHTML = `
          <div class="sym">${sym} <span class="meta">${name}</span></div>
          <div class="meta">
            mcap: ${fmtUsd(c.mcap)} • vol: ${fmtUsd(c.vol)} • vm: ${fmtNum(c.vm,2)} • range: ${fmtNum(c.range,1)}%
          </div>
        `;

        const badges = document.createElement("div");
        badges.className = "badges";
        for(const b of getBadges(c)){
          const el = document.createElement("span");
          el.className = "badge " + (b.cls || "");
          el.textContent = b.t;
          badges.appendChild(el);
        }
        left.appendChild(badges);

        const right = document.createElement("div");
        right.className = "right";
        right.innerHTML = `
          <div class="price">€ ${price == null ? "—" : fmtNum(price, price < 1 ? 6 : 2)}</div>
          <div class="pct ${pctClass(ch24)}">${ch24 == null ? "—" : (fmtNum(ch24,2) + "%")}</div>
        `;

        item.appendChild(left);
        item.appendChild(right);
        wrap.appendChild(item);
      }
    }

    stageEl.appendChild(wrap);
    grid.appendChild(stageEl);
  }

  // last scan label
  if(n.ts){
    const d = new Date(n.ts);
    chipLast.textContent = "last scan: " + d.toLocaleString();
  }
}

function renderOrderbook(ob, metaText){
  if(!ob){
    orderbook.innerHTML = `<div class="ob-empty">${metaText || "Geen orderbook geselecteerd."}</div>`;
    return;
  }

  // We accepteren meerdere vormen:
  // - ob = { mid, bidUsd, askUsd, obScore, spreadPct, bids:[{p,q,usd}], asks:[...] }
  // - ob = { bids:[[p,q],[...]], asks:[[p,q],[...]] }
  const bidUsd = ob.bidUsd ?? ob.bidsUsd ?? null;
  const askUsd = ob.askUsd ?? ob.asksUsd ?? null;
  const obScore = ob.obScore ?? ob.score ?? null;
  const spreadPct = ob.spreadPct ?? ob.spread ?? null;

  const scoreCls = obScore == null ? "" : (obScore >= 0 ? "pos":"neg");

  orderbook.innerHTML = `
    <div class="ob-grid">
      <div class="ob-box">
        <h4>SUMMARY</h4>
        <div class="ob-row"><span>Bid USD</span><b>${fmtUsd(bidUsd)}</b></div>
        <div class="ob-row"><span>Ask USD</span><b>${fmtUsd(askUsd)}</b></div>
        <div class="ob-row"><span>Spread</span><b>${spreadPct == null ? "—" : fmtNum(spreadPct,2) + "%"}</b></div>
        <div class="ob-row"><span>OB score</span><b class="${scoreCls}">${obScore == null ? "—" : fmtNum(obScore,3)}</b></div>
      </div>
      <div class="ob-box">
        <h4>NOTES</h4>
        <div class="ob-row"><span>Status</span><b>${metaText || "—"}</b></div>
        <div class="meta" style="margin-top:8px">OB wordt alleen gevuld als de API het meestuurt of als jouw backend een OB endpoint heeft.</div>
      </div>
    </div>
  `;
}

function findCoin(stageKey, sym){
  const n = normalize(lastData);
  const list = n.funnel[stageKey] || [];
  return list.find(c => getSym(c) === sym) || null;
}

async function selectCoin(stageKey, coin){
  const sym = getSym(coin);

  // Orderbook tonen alleen bij ALMOST/ENTRY/HOLD/SELL
  const allowed = ["ALMOST","ENTRY","HOLD","SELL"].includes(stageKey);
  if(!allowed){
    renderOrderbook(null, "Orderbook wordt pas getoond bij ALMOST/ENTRY/HOLD/SELL.");
    return;
  }

  // 1) Als API al orderbook in coin plakt -> direct tonen
  if(coin.orderbook){
    renderOrderbook(coin.orderbook, sym + " (via API)");
    return;
  }

  // 2) Probeer fallback endpoint /api/orderbook?symbol=XXX (als jij die hebt)
  const url = `/api/orderbook?symbol=${encodeURIComponent(sym)}&side=${encodeURIComponent(side)}`;
  showLoader("Orderbook ophalen voor " + sym + "…");
  clearError();
  try{
    const r = await fetchJson(url, 15000);
    chipApi.textContent = "API: " + url;
    chipStatus.textContent = "status: " + r.status;
    chipMs.textContent = r.ms + "ms";

    if(!r.ok){
      renderOrderbook(null, sym + " (geen OB: endpoint 404/geen data)");
      return;
    }
    renderOrderbook(r.data, sym + " (via /api/orderbook)");
  } catch(e){
    renderOrderbook(null, sym + " (OB error/timeout)");
  } finally {
    hideLoader(); // ✅ balk altijd weg
  }
}

async function load(triggerScan){
  const endpoint = side === "bull" ? API.bull : API.bear;

  showLoader(triggerScan ? "Scan draaien…" : "Data laden…");
  clearError();

  // scan knop: we gebruiken query om de backend eventueel te triggeren,
  // maar als je backend dit niet gebruikt is het harmless.
  const url = triggerScan ? `${endpoint}?scan=1&t=${Date.now()}` : `${endpoint}?t=${Date.now()}`;

  chipApi.textContent = "API: " + endpoint;
  chipStatus.textContent = "status: …";
  chipMs.textContent = "…ms";

  try{
    const r = await fetchJson(url, 25000);
    chipStatus.textContent = "status: " + r.status;
    chipMs.textContent = r.ms + "ms";

    if(!r.ok){
      lastData = null;
      renderOrderbook(null, "Geen orderbook geselecteerd.");
      grid.innerHTML = "";
      showError(`API fout (${r.status}). Check of ${endpoint} bestaat en JSON teruggeeft.`);
      return;
    }

    lastData = r.data;
    render();
    renderOrderbook(null, "Klik een coin in ALMOST/ENTRY/HOLD/SELL om orderbook te zien.");
  } catch(e){
    lastData = null;
    grid.innerHTML = "";
    renderOrderbook(null, "Geen orderbook geselecteerd.");
    showError("Timeout / netwerkfout. Probeer opnieuw.");
  } finally {
    hideLoader(); // ✅ balk gaat altijd weg
  }
}

btnBull.onclick = () => setSide("bull");
btnBear.onclick = () => setSide("bear");
btnScan.onclick = () => load(true);
btnRefresh.onclick = () => load(false);
search.oninput = () => render();

// Start
load(false);
JS

# Commit + push
git add -A
git commit -m "UI: restore styled funnel (ENTRY top), fix loader bar, clean orderbook panel" || true
git push

echo "✅ UI update gepusht. Vercel pakt dit vanzelf op."
