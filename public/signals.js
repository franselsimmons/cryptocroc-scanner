const el = id => document.getElementById(id);

function safeArray(value){
  if(Array.isArray(value)) return value;
  if(value && Array.isArray(value.actions)) return value.actions;
  return [];
}

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toNumber(value){
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(value){
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtNum(value, decimals = 2){
  const n = toNumber(value);
  return n === null ? "—" : n.toFixed(decimals);
}

function fmtInt(value){
  return String(Math.round(safeNumber(value, 0)));
}

function fmtPrice(value){
  const n = toNumber(value);
  if(n === null) return "—";

  if(Math.abs(n) >= 100) return n.toFixed(2);
  if(Math.abs(n) >= 1) return n.toFixed(4);
  if(Math.abs(n) >= 0.01) return n.toFixed(6);

  return n.toFixed(8);
}

function fmtTime(ts){
  const n = Number(ts || 0);
  if(!Number.isFinite(n) || n <= 0) return "—";

  return new Date(n).toLocaleString("nl-NL", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function fmtSign(value){
  const n = toNumber(value);
  if(n === null) return "—";
  if(n > 0) return `+${n.toFixed(2)}`;
  if(n < 0) return n.toFixed(2);
  return "0.00";
}

function setText(id, value){
  const node = el(id);
  if(node) node.innerText = value;
}

function getActions(data){
  if(Array.isArray(data?.trades)) return data.trades;
  if(Array.isArray(data?.tradeSystemResult?.actions)) return data.tradeSystemResult.actions;
  return [];
}

function actionType(row){
  return String(row?.action || "WAIT").toUpperCase();
}

function sideLabel(side){
  const s = String(side || "").toLowerCase();

  if(s === "bull") return "LONG";
  if(s === "bear") return "SHORT";

  return s.toUpperCase() || "—";
}

function pill(text, cls){
  return `<span class="pill ${cls}">${escapeHtml(text)}</span>`;
}

function actionPill(action){
  const a = String(action || "WAIT").toUpperCase();
  return pill(a, `pill-${a.toLowerCase()}`);
}

function sidePill(side){
  const s = String(side || "").toLowerCase();

  if(s === "bull") return pill("LONG", "pill-long");
  if(s === "bear") return pill("SHORT", "pill-short");

  return pill(s || "—", "pill-wait");
}

function gradePill(grade){
  const g = String(grade || "N/A").toUpperCase();
  return pill(g, `pill-grade-${g.toLowerCase()}`);
}

function getReasonScore(row){
  const direct = toNumber(row?.reasonScore);
  if(direct !== null) return direct;

  const reason = String(row?.reason || "").toUpperCase();

  if(reason === "LOW_RR" || reason === "LOW_FINAL_RR"){
    const rr = toNumber(row?.rr);
    const required = toNumber(row?.requiredRR);
    return rr !== null && required !== null ? rr - required : null;
  }

  if(reason === "LOW_CONFLUENCE"){
    const conf = toNumber(row?.confluence);
    const required = toNumber(row?.requiredConfluence);
    return conf !== null && required !== null ? conf - required : null;
  }

  if(reason === "RSI_MID_NO_EDGE"){
    const conf = toNumber(row?.confluence);
    return conf !== null ? conf - 72 : null;
  }

  if(reason === "SETUP_NOT_READY"){
    const conf = toNumber(row?.confluence);
    const sniper = toNumber(row?.sniperScore);
    if(conf !== null && sniper !== null){
      return Math.min(conf - 75, sniper - 72);
    }
  }

  return null;
}

function getBottleneckAdvice(reason, avg){
  const r = String(reason || "").toUpperCase();

  const map = {
    RSI_DATA_INVALID: "Geen 15m/1h RSI-data. Check Bitget candle fetch/rate-limit.",
    RSI_HTF_BLOCKED: "4h RSI blokkeert tegenrichting. Niet versoepelen zonder sample.",
    RSI_LONG_TOO_HIGH: "Long komt te laat na extensie. Scanner timing verbeteren.",
    RSI_LONG_NO_EDGE: "Long mist RSI pullback/continuation edge.",
    RSI_SHORT_NO_EDGE: "Short mist RSI upper-zone of continuation edge.",
    RSI_SHORT_TOO_LOW_A_ONLY: "Oversold shorts correct geblokkeerd tijdens A-only tuning.",
    RSI_MID_NO_EDGE: "MID RSI alleen toelaten bij sterke trend + sniper + confluence.",
    ORDERBOOK_FETCH_FAILED: "Bitget orderbook faalt. Check symbol mapping/rate-limit.",
    NO_MOMENTUM: "Te weinig 1h/24h momentum. Niet blind versoepelen.",
    NO_FAKE_BREAKOUT: "Non-trend setup mist sweep/reclaim context.",
    LOW_RR: "RR onder dynamische vloer. Alleen verlagen bij bewezen shadow winners.",
    LOW_FINAL_RR: "A/GOD final RR onvoldoende na TP-multiplier.",
    LOW_VOL: "Chop filter. Correct voor lagere noise.",
    NO_FLOW: "Geen TREND/BUILDING flow. Scanner mag meer sturen, runner niet te los maken.",
    ENTRY_FILTERED_TF_WEAK: "MTF te zwak. Scanner TF alignment verbeteren.",
    LOW_CONFLUENCE: "Setup mist bevestiging. Niet versoepelen zonder gesloten sample.",
    OB_AGAINST: "Orderbook tegen trade. Correcte hard gate.",
    BAD_MARKET_QUALITY: "Spread/depth onvoldoende. Execution risk.",
    MID_BULL_SPREAD_TOO_WIDE: "MID long heeft te brede spread. Correcte execution gate.",
    EXTREME_FUNDING: "Funding crowding. Niet versoepelen.",
    BULL_CROWDED_FUNDING: "Long crowded funding. Correct.",
    BEAR_CROWDED_FUNDING: "Short crowded funding. Correct.",
    B_DISABLED_A_ONLY: "B-setups bewust uitgesloten/gescheiden monitoren.",
    SETUP_NOT_READY: "Kwaliteit onder A/B/GOD threshold.",
    COOLDOWN: "Re-entry cooldown actief.",
    SYMBOL_COOLDOWN: "Symbol-level cooldown actief.",
    RECENT_SIGNAL_COOLDOWN: "Recent signal protection actief.",
    DUPLICATE_PROCESSING_LOCK: "Duplicate protection actief."
  };

  if(r.startsWith("SYMBOL_ALREADY_OPEN_")){
    return "Er staat al een positie open op dit symbool.";
  }

  if(r.startsWith("BTC_")){
    return "BTC-gate blokkeert tegen zwakke macro-directionele setup.";
  }

  if(r === "LOW_RR" && avg !== null && avg > -0.08){
    return "Borderline RR. Test alleen met shadow outcomes, niet live versoepelen.";
  }

  if(r === "LOW_CONFLUENCE" && avg !== null && avg > -4){
    return "Borderline confluence. Mogelijke kandidaat voor -2/-3 test bij hoge sniper.";
  }

  return map[r] || "Controleer deze runner gate in Vercel logs.";
}

function actionPriority(row){
  const a = actionType(row);
  const setup = String(row?.setupClass || "").toUpperCase();

  if(a === "ENTRY" && setup === "GOD") return 9000;
  if(a === "ENTRY" && setup === "A") return 8000;
  if(a === "ENTRY" && setup === "B") return 7000;
  if(a === "ENTRY") return 6000;
  if(a === "HOLD") return 5000;
  if(a === "EXIT") return 4000;
  if(a === "WAIT") return 1000;

  return 0;
}

function sortActions(rows){
  return [...rows].sort((a, b) => {
    const p = actionPriority(b) - actionPriority(a);
    if(p !== 0) return p;

    const c = safeNumber(b?.confluence, 0) - safeNumber(a?.confluence, 0);
    if(c !== 0) return c;

    return safeNumber(b?.score, 0) - safeNumber(a?.score, 0);
  });
}

/* ================= METRICS ================= */

function updateMetrics(data, actions){
  const btcState = data?.btc?.state || "UNKNOWN";
  const btc24 = data?.btc?.chg24 !== undefined
    ? ` ${safeNumber(data.btc.chg24).toFixed(2)}%`
    : "";

  const regime = data?.regime || "UNKNOWN";

  const entryCount = actions.filter(x => actionType(x) === "ENTRY").length;
  const holdCount = actions.filter(x => actionType(x) === "HOLD").length;
  const waitCount = actions.filter(x => actionType(x) === "WAIT").length;
  const exitCount = actions.filter(x => actionType(x) === "EXIT").length;

  const inputCount =
    safeNumber(data?.tradeFunnelInputCount, null) ??
    safeNumber(data?.candidates, 0);

  setText("btcTrend", `${btcState}${btc24}`);
  setText("regime", regime);
  setText("funnelCount", inputCount);
  setText("waitCount", waitCount);
  setText("entryCount", entryCount);
  setText("holdCount", holdCount);
  setText("exitCount", exitCount);

  const strategy =
    data?.tradeSystemResult?.strategyVersion ||
    actions.find(x => x?.strategyVersion)?.strategyVersion ||
    "—";

  setText("strategyVersion", strategy);

  return {
    btcState,
    regime,
    inputCount,
    entryCount,
    holdCount,
    waitCount,
    exitCount,
    strategy
  };
}

/* ================= MARKET EXPLANATION ================= */

function buildBottlenecks(actions){
  const waits = actions.filter(row => actionType(row) === "WAIT");

  const topCandidates = waits.filter(row => {
    const score = safeNumber(row?.score, 0);
    const conf = safeNumber(row?.confluence, 0);
    const grade = String(row?.grade || "").toUpperCase();

    return score >= 70 || conf >= 70 || grade === "A" || grade === "B";
  });

  const source = topCandidates.length ? topCandidates : waits;

  const map = {};

  for(const row of source){
    const reason = String(row?.reason || "UNKNOWN").toUpperCase();

    if(!map[reason]){
      map[reason] = {
        reason,
        count: 0,
        scoreSum: 0,
        scoreSamples: 0,
        examples: []
      };
    }

    map[reason].count++;

    const reasonScore = getReasonScore(row);

    if(reasonScore !== null){
      map[reason].scoreSum += reasonScore;
      map[reason].scoreSamples++;
    }

    if(map[reason].examples.length < 6){
      map[reason].examples.push(
        `${row.symbol || "?"}_${row.side || "?"}_conf=${row.confluence ?? "—"}_rr=${row.rr ?? "—"}`
      );
    }
  }

  const total = source.length || 1;

  return Object.values(map)
    .map(item => {
      const avg = item.scoreSamples
        ? item.scoreSum / item.scoreSamples
        : null;

      const impactPct = (item.count / total) * 100;

      return {
        ...item,
        avg,
        impactPct,
        priority:
          impactPct >= 35
            ? "HIGH"
            : impactPct >= 18
              ? "MEDIUM"
              : "LOW",
        advice: getBottleneckAdvice(item.reason, avg)
      };
    })
    .sort((a, b) => {
      const pctDiff = b.impactPct - a.impactPct;
      if(pctDiff !== 0) return pctDiff;

      return b.count - a.count;
    });
}

function renderMarketExplanation(data, metrics, bottlenecks){
  const lines = [];

  if(metrics.btcState === "BEARISH"){
    lines.push("BTC is bearish: longs krijgen extra macro-gate, shorts hebben voordeel.");
  }else if(metrics.btcState === "BULLISH"){
    lines.push("BTC is bullish: shorts krijgen extra macro-gate, longs hebben voordeel.");
  }else{
    lines.push(`BTC-state is ${metrics.btcState}. Runner gebruikt score/flow gates strenger bij twijfel.`);
  }

  if(metrics.regime === "LOW_VOL" || metrics.regime === "LOW"){
    lines.push("Low-vol regime: runner laat minder setups door om chop te vermijden.");
  }else if(metrics.regime === "HIGH_VOL" || metrics.regime === "HIGH"){
    lines.push("High-vol regime: meer beweging, maar spread/SL/funding gates worden belangrijker.");
  }else{
    lines.push(`Regime: ${metrics.regime}. Normale runner gates actief.`);
  }

  lines.push(
    `Input: ${metrics.inputCount} runner candidates · ENTRY ${metrics.entryCount} · HOLD ${metrics.holdCount} · WAIT ${metrics.waitCount} · EXIT ${metrics.exitCount}.`
  );

  if(metrics.entryCount === 0 && metrics.holdCount === 0 && metrics.waitCount > 0){
    const top = bottlenecks[0];
    lines.push(
      top
        ? `Geen nieuwe runner entry. Grootste bottleneck: ${top.reason} (${top.impactPct.toFixed(1)}%).`
        : "Geen nieuwe runner entry. Geen duidelijke bottleneck gevonden."
    );
  }

  if(metrics.entryCount > 0){
    lines.push("Runner heeft actieve ENTRY signalen. Controleer RR, SL, TP en confluence in de ENTRY tabel.");
  }

  el("marketExplanation").innerText = lines.join("\n");
}

/* ================= SUMMARY ================= */

function renderRunnerSummary(data, metrics, actions){
  const updatedAt =
    data?.updatedAt ||
    data?.tradeFunnelUpdatedAt ||
    data?.storedAt ||
    data?.servedAt ||
    0;

  const durable =
    data?.tradeSystemResult?.durableEnabled !== undefined
      ? data.tradeSystemResult.durableEnabled
      : data?.durableEnabled;

  const source = data?.source || "unknown";
  const scanSide = data?.scanSide || data?.scanMode || "both";

  const avgConf = average(actions.map(x => toNumber(x?.confluence)).filter(x => x !== null));
  const avgRR = average(actions.map(x => toNumber(x?.rr)).filter(x => x !== null));
  const avgScore = average(actions.map(x => toNumber(x?.score)).filter(x => x !== null));

  el("runnerSummary").innerHTML = `
    <div class="summaryGrid">
      <div class="summaryBox">
        <span>Source</span>
        <strong>${escapeHtml(source)}</strong>
      </div>

      <div class="summaryBox">
        <span>Scan side</span>
        <strong>${escapeHtml(scanSide)}</strong>
      </div>

      <div class="summaryBox">
        <span>Last update</span>
        <strong>${escapeHtml(fmtTime(updatedAt))}</strong>
      </div>

      <div class="summaryBox">
        <span>Durable state</span>
        <strong>${durable === true ? "ON" : durable === false ? "OFF" : "—"}</strong>
      </div>

      <div class="summaryBox">
        <span>Avg confluence</span>
        <strong>${avgConf === null ? "—" : avgConf.toFixed(1)}</strong>
      </div>

      <div class="summaryBox">
        <span>Avg RR</span>
        <strong>${avgRR === null ? "—" : avgRR.toFixed(2)}</strong>
      </div>

      <div class="summaryBox">
        <span>Avg score</span>
        <strong>${avgScore === null ? "—" : avgScore.toFixed(1)}</strong>
      </div>

      <div class="summaryBox">
        <span>Total actions</span>
        <strong>${actions.length}</strong>
      </div>
    </div>
  `;
}

function average(values){
  if(!Array.isArray(values) || !values.length) return null;
  return values.reduce((sum, x) => sum + Number(x || 0), 0) / values.length;
}

/* ================= BOTTLENECK TABLE ================= */

function renderBottleneckTable(bottlenecks){
  const box = el("bottleneckTable");

  if(!bottlenecks.length){
    box.innerHTML = `<p class="emptyState">Geen WAIT bottlenecks gevonden.</p>`;
    return;
  }

  const rows = bottlenecks.map(item => `
    <tr>
      <td><strong>${escapeHtml(item.reason)}</strong></td>
      <td>${escapeHtml(item.priority)}</td>
      <td>${item.count}</td>
      <td>${item.impactPct.toFixed(1)}%</td>
      <td class="${item.avg !== null && item.avg < 0 ? "negative" : "positive"}">${item.avg === null ? "—" : fmtSign(item.avg)}</td>
      <td>${escapeHtml(item.advice)}</td>
      <td>${escapeHtml(item.examples.join(", "))}</td>
    </tr>
  `).join("");

  box.innerHTML = `
    <div class="tableWrap">
      <table class="runnerTable">
        <thead>
          <tr>
            <th>Reason</th>
            <th>Priority</th>
            <th>Count</th>
            <th>Impact</th>
            <th>Shortfall</th>
            <th>Advies</th>
            <th>Examples</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/* ================= OPTIMIZER BOX ================= */

function renderOptimizerBox(data){
  const strategy =
    data?.tradeSystemResult?.strategyVersion ||
    data?.strategyVersion ||
    "onbekend";

  const durable =
    data?.tradeSystemResult?.durableEnabled !== undefined
      ? data.tradeSystemResult.durableEnabled
      : data?.durableEnabled;

  const lines = [
    `Strategy version: ${strategy}`,
    `Durable runtime state: ${durable === true ? "ON" : durable === false ? "OFF" : "UNKNOWN"}`,
    "",
    "Vercel log keys:",
    "• TS_AUDIT_SNAPSHOT",
    "• TS_OPTIMIZER_REPORT",
    "• TS_OPTIMIZER_MFE_MAE",
    "• TS_OPTIMIZER_POST_EXIT",
    "• TS_BEST_SETUP_ADVICE",
    "• TS_FEATURE_THRESHOLD_OPTIMIZER",
    "• TS_FINAL_FILTER_DECISION",
    "",
    "Gebruik TS_FINAL_FILTER_DECISION voor de harde conclusie: welke thresholds leveren de beste winrate + PnL-combinatie."
  ];

  el("optimizerBox").innerText = lines.join("\n");
}

/* ================= ACTION TABLES ================= */

function renderActionTable(containerId, actions, targetAction){
  const container = el(containerId);
  const filtered = sortActions(actions.filter(row => actionType(row) === targetAction));

  if(!filtered.length){
    container.innerHTML = `<p class="emptyState">Geen ${targetAction} rows.</p>`;
    return;
  }

  const rowClass =
    targetAction === "ENTRY"
      ? "entryRow"
      : targetAction === "HOLD"
        ? "holdRow"
        : targetAction === "EXIT"
          ? "exitRow"
          : "waitRow";

  const rows = filtered.map(row => {
    const entry = row?.entry ?? row?.price;
    const rr = row?.rr ?? row?.finalRr ?? "—";

    return `
      <tr class="${rowClass}">
        <td>${escapeHtml(row?.symbol || "UNKNOWN")}</td>
        <td>${sidePill(row?.side)}</td>
        <td>${actionPill(row?.action)}</td>
        <td>${gradePill(row?.setupClass || row?.grade || "N/A")}</td>
        <td>${escapeHtml(row?.reason || "—")}</td>
        <td>$${fmtPrice(entry)}</td>
        <td>$${fmtPrice(row?.sl)}</td>
        <td>$${fmtPrice(row?.tp)}</td>
        <td>${escapeHtml(String(rr))}</td>
        <td>${fmtInt(row?.score)}</td>
        <td>${fmtNum(row?.confluence, 0)}</td>
        <td>${fmtNum(row?.sniperScore, 0)}</td>
        <td>${escapeHtml(row?.rsiZone || "—")}</td>
        <td>${escapeHtml(row?.obBias || "—")}</td>
        <td>${fmtNum(row?.spreadPct, 5)}</td>
        <td>${fmtInt(row?.depthMinUsd1p)}</td>
        <td>${escapeHtml(row?.flow || "—")}</td>
        <td>${fmtTime(row?.ts)}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <div class="tableWrap">
      <table class="runnerTable">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Side</th>
            <th>Action</th>
            <th>Grade</th>
            <th>Reason</th>
            <th>Entry</th>
            <th>SL</th>
            <th>TP</th>
            <th>RR</th>
            <th>Score</th>
            <th>Conf</th>
            <th>Sniper</th>
            <th>RSI</th>
            <th>OB</th>
            <th>Spread</th>
            <th>Depth</th>
            <th>Flow</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/* ================= LOAD ================= */

async function load(){
  setText("statusLine", "Data laden...");

  try{
    const res = await fetch(`/api/public-latest?t=${Date.now()}`, {
      cache: "no-store"
    });

    if(!res.ok){
      throw new Error(`HTTP_${res.status}`);
    }

    const data = await res.json();
    const actions = getActions(data);

    const metrics = updateMetrics(data, actions);
    const bottlenecks = buildBottlenecks(actions);

    renderMarketExplanation(data, metrics, bottlenecks);
    renderRunnerSummary(data, metrics, actions);
    renderBottleneckTable(bottlenecks);
    renderOptimizerBox(data);

    renderActionTable("entriesTable", actions, "ENTRY");
    renderActionTable("holdTable", actions, "HOLD");
    renderActionTable("waitTable", actions, "WAIT");
    renderActionTable("exitTable", actions, "EXIT");

    const updatedAt =
      data?.updatedAt ||
      data?.tradeFunnelUpdatedAt ||
      data?.storedAt ||
      data?.servedAt ||
      Date.now();

    setText("statusLine", `Laatste update: ${fmtTime(updatedAt)}`);
    setText("statsInfo", `Rows: ${actions.length}`);

  }catch(err){
    console.error("RUNNER SIGNALS LOAD ERROR:", err);

    setText("statusLine", "Fout bij laden.");
    setText("statsInfo", "Offline/error");

    const errorHtml = `<p class="emptyState">Data kon niet geladen worden.</p>`;

    ["runnerSummary", "bottleneckTable", "entriesTable", "holdTable", "waitTable", "exitTable"].forEach(id => {
      const node = el(id);
      if(node) node.innerHTML = errorHtml;
    });

    const m = el("marketExplanation");
    if(m) m.innerText = "Runner public-latest endpoint geeft geen geldige response.";
  }
}

/* ================= RESET ================= */

async function resetStats(){
  const ok = confirm("Dashboard teller resetten? Dit wist geen Vercel logs, alleen opgeslagen dashboardStats.");
  if(!ok) return;

  try{
    const res = await fetch("/api/public-latest?action=resetstats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ action: "resetstats" })
    });

    if(!res.ok){
      throw new Error(`HTTP_${res.status}`);
    }

    await load();

  }catch(err){
    console.error("RESET STATS ERROR:", err);
    alert("Reset mislukt.");
  }
}

/* ================= INIT ================= */

document.addEventListener("DOMContentLoaded", () => {
  const refreshBtn = el("refreshBtn");
  if(refreshBtn) refreshBtn.addEventListener("click", load);

  const resetBtn = el("resetStatsBtn");
  if(resetBtn) resetBtn.addEventListener("click", resetStats);

  load();
});

setInterval(load, 15000);