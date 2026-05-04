const el = id => document.getElementById(id);

let latestCoinsById = new Map();

// ================= HELPERS =================
function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function num(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPrice(value){
  const n = num(value, null);
  if(n === null) return "N/A";

  if(Math.abs(n) >= 1) return n.toFixed(4);
  if(Math.abs(n) >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function fmtPct(value){
  return `${num(value).toFixed(2)}%`;
}

function fmtScore(value){
  return Math.round(num(value));
}

function fmtVm(value){
  return num(value).toFixed(4);
}

function escapeHtml(value){
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeStage(stage){
  const s = String(stage || "radar").toLowerCase();

  if(["entry", "almost", "buildup", "radar"].includes(s)){
    return s;
  }

  return "radar";
}

// ================= RUNNER LABELS =================
function runnerStageLabel(c){
  const stage = normalizeStage(c?.scannerStage || c?.stage);

  if(c?.scannerStageLabel){
    const label = String(c.scannerStageLabel).toUpperCase();

    if(label === "HOT") return "RUNNER HOT";
    if(label === "ALMOST") return "RUNNER SETUP";
    if(label === "BUILDUP") return "PRE-RUNNER";
    if(label === "RADAR") return "WATCH";
  }

  if(stage === "entry") return "RUNNER HOT";
  if(stage === "almost") return "RUNNER SETUP";
  if(stage === "buildup") return "PRE-RUNNER";

  return "WATCH";
}

function runnerIntent(c){
  if(c?.uiOnly) return "WATCH_ONLY";

  const stage = normalizeStage(c?.stage);

  if(c?.tradeIntent){
    const intent = String(c.tradeIntent).toUpperCase();

    if(intent === "HOT_CANDIDATE") return "RUNNER_CANDIDATE";
    if(intent === "CANDIDATE") return "RUNNER_SETUP";
    if(intent === "EARLY_WATCH") return "PRE_RUNNER";
    if(intent === "WATCH") return "WATCH";
  }

  if(stage === "entry") return "RUNNER_CANDIDATE";
  if(stage === "almost") return "RUNNER_SETUP";
  if(stage === "buildup") return "PRE_RUNNER";

  return "WATCH";
}

function sourceLabel(c){
  if(c?.uiOnly) return "UI fallback";
  if(c?.stageSource === "filter") return "Runner filter";
  if(c?.stageSource === "fallback") return "Scanner fallback";
  if(c?.stageSource === "ui_fallback") return "UI fallback";

  return c?.stageSource || "Runner scanner";
}

function flowQuality(c){
  const flow = String(c?.flow || "NEUTRAL").toUpperCase();

  if(flow === "TREND") return "TREND RUNNER";
  if(flow === "BUILDING") return "BUILDING";
  if(flow === "EARLY") return "EARLY";

  return "NEUTRAL";
}

// ================= MODAL =================
function openModalById(id){
  const c = latestCoinsById.get(id);
  if(!c) return;

  el("m-title").innerText = c.symbol || "UNKNOWN";

  el("m-price").innerText = "$" + fmtPrice(c.price);
  el("m-score").innerText = fmtScore(c.moveScore);

  el("m-flow").innerText = flowQuality(c);
  el("m-stage").innerText = runnerStageLabel(c);

  el("m-intent").innerText = runnerIntent(c);
  el("m-source").innerText = sourceLabel(c);

  el("m-change1h").innerText = fmtPct(c.change1h);
  el("m-change24").innerText = fmtPct(c.change24);

  el("m-tf").innerText = num(c.tfScore).toFixed(2);
  el("m-tfalign").innerText = c.tfAlignment || "UNKNOWN";

  el("m-vm").innerText = fmtVm(c.vm);
  el("m-fresh").innerText = fmtScore(c.freshness);

  el("modalOverlay").style.display = "flex";
}

function closeModal(){
  el("modalOverlay").style.display = "none";
}

window.openModalById = openModalById;
window.closeModal = closeModal;

// ================= ROW RENDER =================
function coinRow(c, index, bucket){
  const id = `${bucket}_${index}_${String(c.symbol || "UNKNOWN")}`;
  latestCoinsById.set(id, c);

  const stageLabel = runnerStageLabel(c);
  const intent = runnerIntent(c);
  const source = sourceLabel(c);

  return `
    <div class="coinCard" onclick="openModalById('${escapeHtml(id)}')">
      <div class="c-left">
        <div class="avatar">
          ${escapeHtml(String(c.symbol || "?").substring(0, 2))}
        </div>

        <div>
          <div class="c-sym">
            ${escapeHtml(c.symbol || "UNKNOWN")}
            <span class="miniTag">${escapeHtml(stageLabel)}</span>
          </div>

          <div class="c-flow">
            Flow: ${escapeHtml(flowQuality(c))} | ${escapeHtml(source)}
          </div>

          <div class="c-flow">
            Intent: ${escapeHtml(intent)} | TF: ${num(c.tfScore).toFixed(2)}
          </div>
        </div>
      </div>

      <div class="c-right">
        <div class="c-price">$${fmtPrice(c.price)}</div>
        <div class="c-score">Score: ${fmtScore(c.moveScore)}</div>
        <div class="c-score">1h: ${fmtPct(c.change1h)}</div>
      </div>
    </div>
  `;
}

function emptyText(){
  return "<p style='color:#94a3b8'>Geen bull runner-kandidaten</p>";
}

function renderBucket(id, list, bucket){
  const rows = safeArray(list);
  el(id).innerHTML = rows.length
    ? rows.map((c, i) => coinRow(c, i, bucket)).join("")
    : emptyText();
}

// ================= LOAD =================
async function load(){
  try{
    const res = await fetch(`/api/public-latest?t=${Date.now()}`, {
      cache: "no-store"
    });

    const data = await res.json();

    latestCoinsById = new Map();

    const btcState = data?.btc?.state || "UNKNOWN";
    const btc24 = data?.btc?.chg24 !== undefined
      ? ` ${num(data.btc.chg24).toFixed(2)}%`
      : "";

    const regime = data?.regime || "UNKNOWN";
    const inputCount = num(data?.tradeFunnelInputCount);
    const candidatesBull = num(data?.candidatesBull);

    el("statusLine").innerText =
      `BTC: ${btcState}${btc24} | Regime: ${regime} | Bull runner candidates: ${candidatesBull} | TS input: ${inputCount}`;

    const f = data?.funnel?.bull || {
      entry: [],
      almost: [],
      buildup: [],
      radar: []
    };

    renderBucket("entry", f.entry, "entry");
    renderBucket("almost", f.almost, "almost");
    renderBucket("buildup", f.buildup, "buildup");
    renderBucket("radar", f.radar, "radar");

  }catch(e){
    console.error("Bull runner fetch error:", e);

    if(el("statusLine")){
      el("statusLine").innerText = "Bull runner data kon niet geladen worden";
    }
  }
}

setInterval(load, 15000);
load();