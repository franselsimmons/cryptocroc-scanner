const TOKEN = prompt("Admin token:");

let currentData = null;

// ================= HELPERS =================
function el(id){
  return document.getElementById(id);
}

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeBool(value, fallback = false){
  if(value === true || value === false) return value;
  if(value === undefined || value === null) return fallback;

  const s = String(value).toLowerCase();

  if(["true", "1", "yes", "on"].includes(s)) return true;
  if(["false", "0", "no", "off"].includes(s)) return false;

  return fallback;
}

function escapeHtml(value){
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stageDescription(stage){
  const s = String(stage || "").toLowerCase();

  if(s === "entry") return "Runner hot candidate";
  if(s === "almost") return "Runner setup candidate";
  if(s === "buildup") return "Pre-runner buildup";
  return "Watchlist only";
}

function tradeNumber(value, fallback){
  return safeNumber(value, fallback);
}

// ================= LOAD =================
async function load(){
  try{
    const res = await fetch("/api/filter-config", {
      headers: {
        "x-admin-token": TOKEN
      },
      cache: "no-store"
    });

    const data = await res.json();

    if(data.error){
      el("app").innerHTML = `
        <div class="control-card auth-error-card">
          <h2>❌ Toegang geweigerd</h2>
          <p>Admin token is onjuist of verlopen.</p>
        </div>
      `;
      return;
    }

    currentData = normalizeFilterPayload(data);
    render(currentData);

  }catch(err){
    console.error("Runner control load error:", err);

    el("app").innerHTML = `
      <div class="control-card auth-error-card">
        <h2>❌ Netwerkfout</h2>
        <p>Runner control kon de filter-config niet laden.</p>
      </div>
    `;
  }
}

// ================= NORMALIZER =================
function normalizeStageConfig(stage = {}, fallback = {}){
  return {
    scoreMin: tradeNumber(stage.scoreMin, fallback.scoreMin ?? 0),
    volumeMin: tradeNumber(stage.volumeMin, fallback.volumeMin ?? 0),
    tfMin: tradeNumber(stage.tfMin, fallback.tfMin ?? 0),
    allowNeutral: safeBool(stage.allowNeutral, fallback.allowNeutral ?? false)
  };
}

function normalizeFilterPayload(data = {}){
  const fallback = {
    bull: {
      radar:   { scoreMin: 10, volumeMin: 0.020, tfMin: 0, allowNeutral: true },
      buildup: { scoreMin: 26, volumeMin: 0.035, tfMin: 0, allowNeutral: true },
      almost:  { scoreMin: 42, volumeMin: 0.055, tfMin: 0.8, allowNeutral: true },
      entry:   { scoreMin: 54, volumeMin: 0.070, tfMin: 1.5, allowNeutral: false }
    },
    bear: {
      radar:   { scoreMin: 10, volumeMin: 0.020, tfMin: 0, allowNeutral: true },
      buildup: { scoreMin: 26, volumeMin: 0.035, tfMin: 0, allowNeutral: true },
      almost:  { scoreMin: 42, volumeMin: 0.055, tfMin: 0.8, allowNeutral: true },
      entry:   { scoreMin: 54, volumeMin: 0.070, tfMin: 1.5, allowNeutral: false }
    },
    trade: {
      rrMin: 0.95,
      scoreMin: 48,
      requireTrend: true,
      blockSpoof: true
    }
  };

  const out = {
    bull: {},
    bear: {},
    trade: {}
  };

  for(const side of ["bull", "bear"]){
    for(const stage of ["radar", "buildup", "almost", "entry"]){
      out[side][stage] = normalizeStageConfig(
        data?.[side]?.[stage],
        fallback[side][stage]
      );
    }
  }

  out.trade = {
    rrMin: tradeNumber(data?.trade?.rrMin, fallback.trade.rrMin),
    scoreMin: tradeNumber(data?.trade?.scoreMin, fallback.trade.scoreMin),
    requireTrend: safeBool(data?.trade?.requireTrend, fallback.trade.requireTrend),
    blockSpoof: safeBool(data?.trade?.blockSpoof, fallback.trade.blockSpoof)
  };

  return out;
}

// ================= SLIDER GENERATOR =================
function slider(id, label, value, min, max, step, suffix = ""){
  const isToggle = max === 1 && step === 1;

  let valDisplay = value;
  let extraClass = "";

  if(isToggle){
    valDisplay = value == 1 ? "AAN" : "UIT";
    extraClass = value == 1 ? "on" : "off";
  }else if(suffix){
    valDisplay = `${value}${suffix}`;
  }

  return `
    <div class="control-row">
      <div class="c-label-group">
        <span>${escapeHtml(label)}</span>
        <span class="c-val ${extraClass}" id="${id}_val">${escapeHtml(valDisplay)}</span>
      </div>

      <input
        type="range"
        min="${min}"
        max="${max}"
        step="${step}"
        value="${value}"
        class="slider ${isToggle ? "slider-toggle" : ""}"
        oninput="updateValue('${id}', this.value, ${isToggle}, '${escapeHtml(suffix)}')"
        id="${id}"
      />
    </div>
  `;
}

window.updateValue = function(id, val, isToggle, suffix = ""){
  const valElement = el(id + "_val");
  if(!valElement) return;

  if(isToggle){
    const isOn = val == 1;
    valElement.innerText = isOn ? "AAN" : "UIT";
    valElement.className = `c-val ${isOn ? "on" : "off"}`;
    return;
  }

  valElement.innerText = suffix ? `${val}${suffix}` : val;
};

// ================= BLOCK GENERATOR =================
function block(side, stage, f){
  return `
    <div class="control-card">
      <div class="c-header">
        <div class="c-title">${escapeHtml(stage.toUpperCase())}</div>
        <div class="c-subtitle">${escapeHtml(stageDescription(stage))}</div>
      </div>

      ${slider(`${side}_${stage}_score`, "Minimale Runner Score", f.scoreMin, 5, 95, 1)}
      ${slider(`${side}_${stage}_vol`, "Minimale Volume/Mcap", f.volumeMin, 0.005, 1, 0.005)}
      ${slider(`${side}_${stage}_tf`, "Minimale TF Strength", f.tfMin, 0, 4, 0.1)}
      ${slider(`${side}_${stage}_flow`, "NEUTRAL flow toestaan", f.allowNeutral ? 1 : 0, 0, 1, 1)}
    </div>
  `;
}

// ================= RENDER =================
function render(f){
  let html = "";

  html += `
    <div class="control-info">
      <strong>Runner mode:</strong><br>
      Scanner HOT betekent runner-kandidaat, geen directe entry. 
      TradeSystem beslist pas na orderbook, RSI, liquidity, funding, confluence en RR.
    </div>
  `;

  html += `<h2 class="section-title bull-title">🟢 BULL RUNNER FUNNEL</h2>`;

  for(const stage of ["entry", "almost", "buildup", "radar"]){
    html += block("bull", stage, f.bull[stage]);
  }

  html += `<h2 class="section-title bear-title">🔴 BEAR RUNNER FUNNEL</h2>`;

  for(const stage of ["entry", "almost", "buildup", "radar"]){
    html += block("bear", stage, f.bear[stage]);
  }

  html += `<h2 class="section-title trade-title">⚡ RUNNER EXECUTION GATES</h2>`;

  html += `
    <div class="control-card">
      <div class="c-header">
        <div class="c-title">TRADE PARAMETERS</div>
        <div class="c-subtitle">Final gate voor Discord-signaal</div>
      </div>

      ${slider("trade_rr", "Minimale Runner RR", f.trade.rrMin, 0.8, 4, 0.05)}
      ${slider("trade_score", "Minimale Trade Score", f.trade.scoreMin, 35, 95, 1)}
      ${slider("trade_trend", "Require Trend Flow", f.trade.requireTrend ? 1 : 0, 0, 1, 1)}
      ${slider("trade_spoof", "Block Spoofing", f.trade.blockSpoof ? 1 : 0, 0, 1, 1)}
    </div>
  `;

  html += `
    <div class="action-bar">
      <button class="btn-save" onclick="save()">💾 Opslaan</button>
      <button class="btn-ai" onclick="applyAI()">🤖 Apply optimizer</button>
    </div>
  `;

  el("app").innerHTML = html;
}

// ================= SAVE =================
window.save = async function(){
  const get = id => el(id)?.value;

  const body = {
    bull: {},
    bear: {},
    trade: {}
  };

  for(const side of ["bull", "bear"]){
    for(const stage of ["radar", "buildup", "almost", "entry"]){
      body[side][stage] = {
        scoreMin: Number(get(`${side}_${stage}_score`)),
        volumeMin: Number(get(`${side}_${stage}_vol`)),
        tfMin: Number(get(`${side}_${stage}_tf`)),
        allowNeutral: get(`${side}_${stage}_flow`) == 1
      };
    }
  }

  body.trade = {
    rrMin: Number(get("trade_rr")),
    scoreMin: Number(get("trade_score")),
    requireTrend: get("trade_trend") == 1,
    blockSpoof: get("trade_spoof") == 1
  };

  try{
    const res = await fetch("/api/filter-config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-token": TOKEN
      },
      body: JSON.stringify(body)
    });

    const data = await res.json().catch(() => null);

    if(!res.ok || data?.error){
      throw new Error(data?.error || "save_failed");
    }

    currentData = normalizeFilterPayload(data);
    render(currentData);

    alert("Runner instellingen opgeslagen.");

  }catch(err){
    console.error("Runner control save error:", err);
    alert("Opslaan mislukt.");
  }
};

// ================= APPLY OPTIMIZER =================
window.applyAI = async function(){
  try{
    const res = await fetch(`/api/public-latest?t=${Date.now()}`, {
      cache: "no-store"
    });

    const data = await res.json();

    const decision =
      data?.tradeSystemAnalysis?.finalFilterDecision ||
      data?.tradeSystemResult?.finalFilterDecision ||
      data?.tradeSystemResult?.optimizer?.finalFilterDecision ||
      null;

    const recommended =
      decision?.conclusion?.setFiltersTo ||
      data?.tradeSystemAnalysis?.recommendedFilterValues ||
      data?.tradeSystemResult?.recommendedFilterValues ||
      null;

    if(!recommended){
      alert("Geen runner optimizer-advies gevonden in latest payload.");
      return;
    }

    alert(
      "Optimizer advies gevonden. Deze UI past nog niet automatisch constants in tradeSystem.js aan. Gebruik Vercel logs: TS_FINAL_FILTER_DECISION."
    );

  }catch(err){
    console.error("Runner optimizer apply error:", err);
    alert("Optimizer data kon niet geladen worden.");
  }
};

// ================= INIT =================
load();