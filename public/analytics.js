const el = id => document.getElementById(id);

window.latestAdvice = {};

// ================= CONFIG =================
const REFRESH_MS = 15_000;

// ================= HELPERS =================
function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function safeObject(value){
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function num(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function countValue(value){
  if(Array.isArray(value)) return value.length;
  return num(value, 0);
}

function fmtTime(ts){
  if(!ts) return "-";

  try{
    return new Date(ts).toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }catch{
    return "-";
  }
}

function fmtDateTime(ts){
  if(!ts) return "-";

  try{
    return new Date(ts).toLocaleString("nl-NL");
  }catch{
    return "-";
  }
}

function pct(count, total){
  if(!total) return 0;
  return Number(((count / total) * 100).toFixed(1));
}

function pctText(value){
  const n = num(value, 0);
  return `${n.toFixed(1)}%`;
}

function fixed(value, decimals = 2){
  return num(value, 0).toFixed(decimals);
}

function signedFixed(value, decimals = 2){
  const n = num(value, 0);
  return `${n > 0 ? "+" : ""}${n.toFixed(decimals)}`;
}

function escapeHtml(value){
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeAction(action){
  return String(action || "").toUpperCase().trim();
}

function normalizeReason(reason){
  return String(reason || "UNKNOWN").toUpperCase().trim();
}

function normalizeKey(value, fallback = "UNKNOWN"){
  const v = String(value || "").trim();
  return v || fallback;
}

function avg(list, field){
  const nums = safeArray(list)
    .map(x => num(x?.[field], NaN))
    .filter(Number.isFinite);

  if(!nums.length) return 0;

  return Number((nums.reduce((a, b) => a + b, 0) / nums.length).toFixed(2));
}

function objectCounterToRows(counter, totalFallback = 0){
  const entries = Object.entries(safeObject(counter));
  const total = totalFallback || entries.reduce((sum, [, count]) => sum + num(count), 0);

  return entries
    .map(([key, count]) => ({
      key: normalizeReason(key),
      count: num(count),
      pct: pct(num(count), total),
      advice: getRunnerReasonAdvice(key)
    }))
    .sort((a, b) => b.count - a.count);
}

function rowsFromStatsArray(rows, keyField = "key"){
  return safeArray(rows)
    .map(row => ({
      key: normalizeReason(row?.[keyField] || row?.key || row?.reason || "UNKNOWN"),
      count: num(row?.count ?? row?.total, 0),
      pct: num(row?.pct, 0),
      advice: getRunnerReasonAdvice(row?.[keyField] || row?.key || row?.reason)
    }))
    .sort((a, b) => b.count - a.count);
}

function getFirst(...values){
  for(const value of values){
    if(value !== undefined && value !== null) return value;
  }

  return null;
}

function valueClass(value){
  const n = num(value, 0);
  if(n > 0) return "good";
  if(n < 0) return "bad";
  return "";
}

async function fetchJsonSafe(url){
  try{
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`, {
      cache: "no-store"
    });

    const json = await res.json().catch(() => null);

    if(!res.ok || !json?.ok){
      return {
        ok: false,
        error: json?.error || `http_${res.status}`
      };
    }

    return json;
  }catch(err){
    return {
      ok: false,
      error: err?.message || "fetch_failed"
    };
  }
}

// ================= RUNNER REASON ADVICE =================
function getRunnerReasonAdvice(reason){
  const key = normalizeReason(reason);

  const map = {
    PRICE_INVALID: "Geen geldige prijsdata. Correct geblokkeerd.",
    ORDERBOOK_FETCH_FAILED: "Geen live orderbook. Geen runner-entry zonder execution-data.",
    SPOOF_DETECTED: "Spoofing gedetecteerd. Direct blokkeren.",
    SPREAD_TOO_WIDE: "Spread te breed voor runner execution.",
    DEPTH_TOO_LOW: "Orderbook depth te dun voor runner continuation.",
    BAD_MARKET_QUALITY: "Spread/depth slecht. Correct geblokkeerd.",

    BTC_STRONG_BULL_BLOCK_SHORT: "Short tegen sterke BTC geblokkeerd.",
    BTC_STRONG_BEAR_BLOCK_LONG: "Long tegen zwakke BTC geblokkeerd.",
    BTC_BULLISH_WEAK_SHORT: "Weak short tegen bullish BTC geblokkeerd.",
    BTC_BEARISH_WEAK_LONG: "Weak long tegen bearish BTC geblokkeerd.",
    BTC_NEUTRAL_LOW_SCORE: "BTC neutraal en runner-score te laag.",

    FLOW_NOT_RUNNER: "Geen runner-flow. Scanner moet betere runner-candidates sturen.",
    FLOW_EXHAUSTION: "Exhaustion-flow. Correct geblokkeerd.",
    NO_FLOW: "Geen directionele flow. Niet versoepelen.",
    LOW_VOL: "Te weinig volatiliteit voor runner-profiel.",
    RUNNER_PRESSURE_TOO_LOW: "Directionele runner-pressure is te laag.",
    RUNNER_DECELERATING: "Runner verliest acceleratie.",
    NO_MOMENTUM: "Momentum onvoldoende voor runner.",
    NO_FAKE_BREAKOUT: "Geen fake-breakout of continuation-context bij non-trend.",

    RSI_DATA_INVALID: "RSI MTF data ontbreekt. Geen runner-entry zonder RSI context.",
    RSI_HTF_BLOCKED: "HTF RSI blokkeert directioneel.",
    RSI_BLOCKED: "RSI blokkeert directioneel.",
    RSI_LONG_TOO_HIGH: "Long te laat in RSI. Scanner timing verbeteren.",
    RSI_SHORT_TOO_LOW_A_ONLY: "Short in oversold RSI-zone geblokkeerd.",
    RSI_LONG_NO_EDGE: "Long mist RSI pullback/continuation edge.",
    RSI_SHORT_NO_EDGE: "Short mist RSI pullback/continuation edge.",
    RSI_MID_NO_EDGE: "MID RSI alleen doorlaten bij sterke trend continuation.",
    RSI_NO_RUNNER_EDGE: "RSI geeft geen runner edge.",
    RSI_EXHAUSTED_AGAINST_SIDE: "RSI exhaustion tegen de trade-richting.",

    STRUCTURE_AGAINST: "Market structure staat tegen runner-richting.",
    TF_TOO_WEAK: "Multi-timeframe strength te zwak.",
    ENTRY_FILTERED_TF_WEAK: "TF strength te zwak.",
    LOW_CONFLUENCE: "Confluence mist bevestiging. Niet versoepelen.",
    CONFLUENCE_TOO_LOW: "Confluence mist bevestiging. Niet versoepelen.",
    OB_AGAINST: "Orderbook staat tegen runner-richting.",
    OB_NEUTRAL_LOW_CONF: "Neutraal orderbook alleen accepteren bij hoge confluence.",

    EXTREME_FUNDING: "Funding extreem. Correct geblokkeerd.",
    FUNDING_EXTREME: "Funding extreem. Correct geblokkeerd.",
    BULL_CROWDED_FUNDING: "Long te crowded.",
    BEAR_CROWDED_FUNDING: "Short te crowded.",
    LONG_CROWDED_FUNDING: "Long te crowded.",
    SHORT_CROWDED_FUNDING: "Short te crowded.",

    LOW_RR: "Risk/reward onder runner-floor.",
    RR_TOO_LOW: "Risk/reward onder runner-floor.",
    LOW_FINAL_RR: "Final runner target geeft te weinig RR.",
    FINAL_RR_TOO_LOW: "Final runner target geeft te weinig RR.",

    SETUP_NOT_READY: "Setup mist runner A/B/C kwaliteit.",
    RUNNER_SETUP_NOT_READY: "Setup mist runner A/B/C kwaliteit.",
    NO_VALID_RUNNER_SETUP: "Geen geldige runner setup in deze scan.",
    B_DISABLED_A_ONLY: "B setups bewust uitgeschakeld voor A-only tuning.",

    ENTRY_TYPE_BLOCKED_RUNNER_B: "Runner B continuation is geblokkeerd door slechte cohort-data.",
    BAD_COHORT_FLOW_NEUTRAL: "Flow neutraal. Geen live runner edge.",
    BAD_COHORT_SQUEEZE_LOWER_RSI: "Squeeze in verkeerde RSI-zone. Correct geblokkeerd.",
    BAD_COHORT_MID_BREAKOUT_OB_BULLISH: "Cohort met MID RSI + breakout + OB bullish presteerde slecht.",
    BAD_COHORT_MID_BREAKOUT_OB_BEARISH: "Cohort met MID RSI + breakout + OB bearish presteerde slecht.",

    WATCH_COHORT_MID_RUNNING_OB_NEUTRAL_CONFLUENCE: "Watch-cohort: confluence moet extreem hoog zijn.",
    WATCH_COHORT_MID_RUNNING_OB_NEUTRAL_SNIPER: "Watch-cohort: sniper moet extreem hoog zijn.",
    WATCH_COHORT_MID_RUNNING_OB_NEUTRAL_PRESSURE: "Watch-cohort: runner pressure moet extreem hoog zijn.",

    SCANNER_FLOW_NOT_HOT_RUNNER: "Niet hot genoeg voor live runner. Wordt als shadow-learning behandeld.",

    SYMBOL_COOLDOWN: "Cooldown voorkomt overtrading op dezelfde coin.",
    PAIR_COOLDOWN: "Pair cooldown actief.",
    COOLDOWN: "Cooldown actief.",
    RECENT_SIGNAL_COOLDOWN: "Recent signaal cooldown actief.",
    DUPLICATE_PROCESSING_LOCK: "Duplicate processing protection werkt.",
    PROCESSING_LOCK_ACTIVE: "Duplicate processing protection werkt.",
    MAX_OPEN_TRADES: "Max open runners bereikt.",
    MAX_OPEN_RUNNERS: "Max open runners bereikt."
  };

  if(key.startsWith("SYMBOL_ALREADY_OPEN_")){
    return "Er staat al een runner open op deze coin. Correct geblokkeerd.";
  }

  return map[key] || "Geen specifieke runner-actie nodig.";
}

// ================= ADVICE UI =================
window.toggleAdvice = function(adviceId){
  const elAdvice = el(adviceId);
  if(!elAdvice) return;

  const isHidden = elAdvice.style.display === "none" || !elAdvice.style.display;
  elAdvice.style.display = isHidden ? "block" : "none";
};

function adviceItemToHtml(item){
  if(!item) return "";

  if(typeof item === "string"){
    return `<div>• ${escapeHtml(item)}</div>`;
  }

  const message = item.message || "Onbekend runner advies";

  let actionColor = "#a78bfa";

  if(item.action === "STRENGER") actionColor = "var(--red)";
  if(item.action === "SOEPELER") actionColor = "var(--green)";

  const action = item.action
    ? `<span style="background:rgba(139,92,246,0.2); color:${actionColor}; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:900; margin-right:6px; border:1px solid ${actionColor};">${escapeHtml(item.action)}</span>`
    : "";

  const values = item.current !== undefined && item.recommended !== undefined
    ? `<div style="font-size:12px; opacity:0.8; margin-top:2px;">${escapeHtml(item.current)} → ${escapeHtml(item.recommended)}</div>`
    : "";

  return `<div style="margin-bottom:10px;">• ${action}${escapeHtml(message)}${values}</div>`;
}

// ================= DATA EXTRACTION =================
function getActions(data){
  return safeArray(
    getFirst(
      data?.tradeSystemResult?.actions,
      data?.actions,
      data?.trades
    )
  );
}

function getRunnerStats(data){
  return safeObject(
    getFirst(
      data?.tradeSystemResult?.runnerStats,
      data?.runnerStats,
      data?.tradeSystemAnalysis?.runnerStats
    )
  );
}

function getOpenRunnerRows(data){
  return safeArray(
    getFirst(
      data?.tradeSystemResult?.openPositions,
      data?.tradeSystemAnalysis?.openPositions,
      data?.openPositions
    )
  );
}

function getPerformancePayload(performanceData){
  return safeObject(performanceData?.performance || performanceData);
}

function getTradeStatsPayload(statsData){
  return safeObject(statsData || {});
}

// ================= GLOBAL STATUS =================
function renderGlobalAdvice(data){
  const target = el("globalAdvice");
  const content = el("globalAdviceContent");

  if(!target || !content) return;

  const global = safeArray(data?.advice?.global);

  target.style.display = "block";

  if(global.length){
    content.innerHTML = global.map(g => `• ${escapeHtml(g)}`).join("<br><br>");
    return;
  }

  const bullCount = num(data?.bullCount);
  const bearCount = num(data?.bearCount);
  const candidates = num(data?.candidates);
  const tradeInput = num(data?.tradeFunnelInputCount ?? data?.tradeFunnel?.inputCount);
  const actions = getActions(data).length;

  content.innerHTML = `
    Runner funnel gevuld: Bull ${bullCount}, Bear ${bearCount}.<br>
    Scanner candidates: ${candidates}. Runner input: ${tradeInput}. Runner actions: ${actions}.<br>
    <span class="muted" style="font-size:11px;">
      Runner HOT is scanner-context. Live entry komt alleen uit Runner TradeSystem.
    </span>
  `;
}

// ================= RUNNER TELEMETRY =================
function buildActionCounts(actions){
  const out = {};

  for(const action of safeArray(actions)){
    const key = normalizeAction(action?.action || "UNKNOWN");
    out[key] = (out[key] || 0) + 1;
  }

  return out;
}

function buildWaitRows(actions, stats){
  if(stats?.waitReasons && !Array.isArray(stats.waitReasons)){
    return objectCounterToRows(stats.waitReasons);
  }

  if(Array.isArray(stats?.waitReasons)){
    return rowsFromStatsArray(stats.waitReasons);
  }

  if(stats?.rejectReasonCounts){
    return objectCounterToRows(stats.rejectReasonCounts);
  }

  const waits = safeArray(actions).filter(a => normalizeAction(a?.action) === "WAIT");
  const counter = {};

  for(const w of waits){
    const key = normalizeReason(w?.reason);
    counter[key] = (counter[key] || 0) + 1;
  }

  return objectCounterToRows(counter, waits.length);
}

function buildEntryTypeRows(actions, stats){
  if(stats?.entryTypes && !Array.isArray(stats.entryTypes)){
    return objectCounterToRows(stats.entryTypes);
  }

  if(Array.isArray(stats?.entryTypes)){
    return rowsFromStatsArray(stats.entryTypes);
  }

  if(stats?.entryTypeCounts){
    return objectCounterToRows(stats.entryTypeCounts);
  }

  const entries = safeArray(actions).filter(a => normalizeAction(a?.action) === "ENTRY");
  const counter = {};

  for(const entry of entries){
    const key = normalizeReason(
      entry?.runnerEntryType ||
      entry?.entryType ||
      entry?.reason ||
      entry?.setupClass ||
      "RUNNER_ENTRY"
    );

    counter[key] = (counter[key] || 0) + 1;
  }

  return objectCounterToRows(counter, entries.length);
}

function extractShadowStats(stats){
  const shadowRowsRaw = stats?.shadowRows;
  const shadowRows = safeArray(shadowRowsRaw);
  const completed = shadowRows.filter(row => String(row?.status || "").toUpperCase() !== "OPEN");

  const shadowWins = num(stats?.shadowWins, completed.filter(row => row?.win || num(row?.exitR) > 0).length);
  const shadowLosses = num(stats?.shadowLosses, completed.filter(row => row?.loss || num(row?.exitR) < 0).length);

  return {
    featureRows: countValue(stats?.featureRows ?? stats?.featureStoreRows),
    shadowRows: countValue(stats?.shadowRows ?? stats?.shadowOutcomeRows),
    shadowWins,
    shadowLosses
  };
}

function buildRunnerRecommendations({ actions, stats, waitRows, entryRows }){
  const actionCounts = buildActionCounts(actions);

  const total = safeArray(actions).length;
  const entries = num(actionCounts.ENTRY);
  const waits = num(actionCounts.WAIT);
  const holds = num(actionCounts.HOLD);
  const partials = num(actionCounts.PARTIAL_TP) + num(actionCounts.PARTIAL);
  const trails = num(actionCounts.TRAIL);
  const beMoves = num(actionCounts.MOVE_BE);
  const exits = num(actionCounts.EXIT);

  const topWait = waitRows[0]?.key || null;

  const winrate = num(stats?.winrate);
  const avgR = num(stats?.avgR);
  const avgMfeR = num(stats?.avgMfeR);
  const avgMaeR = num(stats?.avgMaeR);
  const shadowWins = num(stats?.shadowWins);
  const shadowLosses = num(stats?.shadowLosses);

  const moreRunners = [];
  const higherWinrate = [];
  const higherPnl = [];

  if(total === 0){
    moreRunners.push("Geen runner actions. Verhoog scanner-runner input: HOT/ALMOST moeten trend-flow + fresh acceleration bevatten.");
  }

  if(total > 0 && entries === 0 && waits > 0){
    moreRunners.push(`Geen entries. Grootste runner-blokkade: ${topWait || "UNKNOWN"}. Alleen versoepelen als shadow outcomes dit positief bevestigen.`);
  }

  if(["FLOW_NOT_RUNNER", "RUNNER_PRESSURE_TOO_LOW", "NO_MOMENTUM"].includes(topWait)){
    moreRunners.push("Meer runners moet uit scanner komen: hogere 1h acceleration, volume/mcap en directionele pressure.");
  }

  if(["SPREAD_TOO_WIDE", "DEPTH_TOO_LOW", "BAD_MARKET_QUALITY"].includes(topWait)){
    higherWinrate.push("Execution-filter werkt. Runner entries op dunne books blijven blokkeren.");
  }

  if(["RSI_LONG_TOO_HIGH", "RSI_SHORT_TOO_LOW_A_ONLY", "RSI_NO_RUNNER_EDGE", "RSI_MID_NO_EDGE"].includes(topWait)){
    higherWinrate.push("RSI timing is de bottleneck. Scanner moet earlier pullback/continuation sturen, niet late extension.");
  }

  if(["LOW_CONFLUENCE", "CONFLUENCE_TOO_LOW", "OB_AGAINST"].includes(topWait)){
    higherWinrate.push("Kwaliteitsblokkade is terecht. Alleen versoepelen als shadow-wins deze reden structureel positief maken.");
  }

  if(entries > 0 && partials === 0 && holds > 0){
    higherPnl.push("Open runners hebben nog geen partials. Monitor MFE; partial logic pas aanpassen na genoeg closed/partial sample.");
  }

  if(partials > 0 && trails === 0){
    higherPnl.push("Partials worden genomen maar trailing triggert niet. Runner PnL zit waarschijnlijk in trail-afstand en follow-through.");
  }

  if(beMoves > 0 && exits > 0 && avgR <= 0){
    higherPnl.push("BE wordt geraakt maar avgR blijft laag. Check of BE te vroeg staat of entries te vroeg zijn.");
  }

  if(avgMfeR > 1.5 && avgR < 0.6){
    higherPnl.push("MFE is veel hoger dan realized R. TP/partial/trailing is te conservatief of trail knijpt te snel.");
  }

  if(avgMaeR < -1.2 && avgR < 0){
    higherWinrate.push("MAE is diep. Entry timing verbeteren vóór targets verruimen.");
  }

  if(winrate >= 55 && avgR > 0){
    higherPnl.push("Runner-profiel gezond. Optimaliseer nu runner exits: partial later of trail ruimer per cohort.");
  }

  if(winrate > 0 && winrate < 45){
    higherWinrate.push("Winrate te laag. Entry-kwaliteit strenger: confluence/sniper/OB alignment omhoog.");
  }

  if(shadowWins > shadowLosses && shadowWins >= 5){
    moreRunners.push("Shadow outcomes tonen gemiste winners. Test alleen de beste rejected reason gecontroleerd soepeler.");
  }

  if(!moreRunners.length){
    moreRunners.push("Meer runners niet forceren. Eerst runner-flow, MFE/MAE en shadow sample opbouwen.");
  }

  if(!higherWinrate.length){
    higherWinrate.push("Winrate-filters behouden: RSI, OB, funding, BTC gate en structure blijven leidend.");
  }

  if(!higherPnl.length){
    higherPnl.push("PnL-advies wordt sterker zodra er genoeg partial/trail/exit runner-history is.");
  }

  return {
    moreRunners,
    higherWinrate,
    higherPnl,
    topEntryType: entryRows[0] || null,
    topReject: waitRows[0] || null
  };
}

function buildRunnerTelemetry(data){
  const actions = getActions(data);
  const stats = getRunnerStats(data);
  const actionCounts = buildActionCounts(actions);
  const waitRows = buildWaitRows(actions, stats);
  const entryRows = buildEntryTypeRows(actions, stats);

  const totalActions = actions.length;
  const openRows = getOpenRunnerRows(data);

  const entries = num(getFirst(stats.entries, actionCounts.ENTRY));
  const waits = num(actionCounts.WAIT);
  const holds = num(actionCounts.HOLD);
  const partials = num(getFirst(stats.partials, actionCounts.PARTIAL_TP + actionCounts.PARTIAL));
  const trails = num(getFirst(stats.trails, actionCounts.TRAIL));
  const beMoves = num(getFirst(stats.movesToBE, actionCounts.MOVE_BE));
  const exits = num(getFirst(stats.exits, actionCounts.EXIT));
  const adds = num(getFirst(stats.adds, actionCounts.ADD));

  const wins = num(stats.wins);
  const losses = num(stats.losses);
  const closed = wins + losses;

  const winrate = closed > 0
    ? pct(wins, closed)
    : num(stats.winrate, 0);

  const avgR = num(stats.avgR);
  const totalR = num(stats.totalR);
  const avgMfeR = num(stats.avgMfeR);
  const avgMaeR = num(stats.avgMaeR);

  const shadow = extractShadowStats(stats);

  const recommendations = buildRunnerRecommendations({
    actions,
    stats: {
      ...stats,
      winrate,
      avgR,
      totalR,
      avgMfeR,
      avgMaeR,
      shadowWins: shadow.shadowWins,
      shadowLosses: shadow.shadowLosses
    },
    waitRows,
    entryRows
  });

  return {
    totalActions,
    scannerCandidates: num(data?.candidates),
    tradeFunnelInputCount: num(data?.tradeFunnelInputCount ?? data?.tradeFunnel?.inputCount),
    entries,
    waits,
    holds,
    partials,
    trails,
    beMoves,
    exits,
    adds,
    openRunners: num(getFirst(stats.openPositions, openRows.length)),
    wins,
    losses,
    winrate,
    avgR,
    totalR,
    avgMfeR,
    avgMaeR,
    featureRows: shadow.featureRows,
    shadowRows: shadow.shadowRows,
    shadowWins: shadow.shadowWins,
    shadowLosses: shadow.shadowLosses,
    waitRows,
    entryRows,
    recommendations,
    actionCounts
  };
}

function renderMetric(label, value, cls = ""){
  return `
    <div class="metric-box">
      <span>${escapeHtml(label)}</span>
      <strong class="${escapeHtml(cls)}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderTelemetryRows(rows, emptyText){
  if(!safeArray(rows).length){
    return `<div class="muted" style="text-align:center; padding:10px;">${escapeHtml(emptyText)}</div>`;
  }

  return rows.map(row => `
    <div class="telemetry-card">
      <div class="telemetry-head">
        <div class="telemetry-name">${escapeHtml(row.key)}</div>
        <div class="telemetry-badge">${num(row.count)}x · ${num(row.pct)}%</div>
      </div>
      <div class="telemetry-advice">${escapeHtml(row.advice || "Geen actie nodig.")}</div>
    </div>
  `).join("");
}

function renderRecommendationBlock(title, list){
  const rows = safeArray(list).length
    ? list.map(x => `• ${escapeHtml(x)}`).join("<br>")
    : "• Geen advies beschikbaar.";

  return `
    <div class="runner-advice">
      <strong>${escapeHtml(title)}</strong><br>
      ${rows}
    </div>
  `;
}

function renderRunnerTelemetry(data){
  const box = el("runnerTelemetry");
  if(!box) return;

  const ts = buildRunnerTelemetry(data);
  const rec = ts.recommendations;

  box.innerHTML = `
    <h2 class="runner-title">🚀 Runner Telemetry Engine</h2>
    <div class="runner-subtitle">
      Live runner actions + open position management + shadow-learning telemetry.
    </div>

    <div class="metric-grid">
      ${renderMetric("Scanner Candidates", ts.scannerCandidates)}
      ${renderMetric("Runner Input", ts.tradeFunnelInputCount)}
      ${renderMetric("Actions", ts.totalActions)}
      ${renderMetric("Open Runners", ts.openRunners)}

      ${renderMetric("Entries", ts.entries)}
      ${renderMetric("Waits", ts.waits)}
      ${renderMetric("Holds", ts.holds)}
      ${renderMetric("Partials", ts.partials)}

      ${renderMetric("Move BE", ts.beMoves)}
      ${renderMetric("Trails", ts.trails)}
      ${renderMetric("Adds", ts.adds)}
      ${renderMetric("Exits", ts.exits)}

      ${renderMetric("Wins / Losses", `${ts.wins} / ${ts.losses}`)}
      ${renderMetric("Winrate", pctText(ts.winrate), ts.winrate >= 55 ? "good" : ts.winrate > 0 && ts.winrate < 45 ? "bad" : "")}
      ${renderMetric("Avg R", fixed(ts.avgR, 2), valueClass(ts.avgR))}
      ${renderMetric("Total R", fixed(ts.totalR, 2), valueClass(ts.totalR))}

      ${renderMetric("Avg MFE R", fixed(ts.avgMfeR, 2))}
      ${renderMetric("Avg MAE R", fixed(ts.avgMaeR, 2))}
      ${renderMetric("Feature Rows", ts.featureRows)}
      ${renderMetric("Shadow Rows", ts.shadowRows)}

      ${renderMetric("Shadow Wins", ts.shadowWins)}
      ${renderMetric("Shadow Losses", ts.shadowLosses)}
    </div>

    ${renderRecommendationBlock("📈 Meer runner entries", rec.moreRunners)}
    ${renderRecommendationBlock("🎯 Hogere runner winrate", rec.higherWinrate)}
    ${renderRecommendationBlock("💰 Hogere runner PnL", rec.higherPnl)}

    <div class="runner-section-label">Top Runner Rejects</div>
    <div class="telemetry-list">
      ${renderTelemetryRows(ts.waitRows.slice(0, 10), "Geen runner blokkades deze scan.")}
    </div>

    <div class="runner-section-label">Runner Entry Types</div>
    <div class="telemetry-list">
      ${renderTelemetryRows(ts.entryRows.slice(0, 8), "Geen runner entries deze scan.")}
    </div>
  `;
}

// ================= RUNNER PERFORMANCE =================
function renderPerformanceRows(title, rows, limit = 8){
  const clean = safeArray(rows).slice(0, limit);

  if(!clean.length){
    return `
      <div class="runner-section-label">${escapeHtml(title)}</div>
      <div class="muted" style="padding:10px 0;">Geen data.</div>
    `;
  }

  return `
    <div class="runner-section-label">${escapeHtml(title)}</div>
    <div class="table-wrap">
      <table class="runner-table">
        <thead>
          <tr>
            <th>Key</th>
            <th>Total</th>
            <th>Wins</th>
            <th>Losses</th>
            <th>Winrate</th>
            <th>Total PnL%</th>
            <th>Avg PnL%</th>
            <th>Avg RR</th>
          </tr>
        </thead>
        <tbody>
          ${clean.map(row => `
            <tr>
              <td><span class="pill runner">${escapeHtml(row.key || "UNKNOWN")}</span></td>
              <td>${num(row.total)}</td>
              <td>${num(row.wins)}</td>
              <td>${num(row.losses)}</td>
              <td>${pctText(row.winrate)}</td>
              <td class="${valueClass(row.totalPnlPct)}">${signedFixed(row.totalPnlPct, 3)}%</td>
              <td class="${valueClass(row.avgPnlPct)}">${signedFixed(row.avgPnlPct, 3)}%</td>
              <td>${fixed(row.avgRR, 2)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderRunnerPerformance(performanceData, tradeStatsData){
  const box = el("runnerPerformance");
  if(!box) return;

  const perf = getPerformancePayload(performanceData);
  const stats = getTradeStatsPayload(tradeStatsData);

  const overall = safeObject(stats.overall);
  const perfTotal = num(getFirst(perf.total, overall.total));
  const wins = num(getFirst(perf.wins, overall.wins));
  const losses = num(getFirst(perf.losses, overall.losses));
  const flats = num(getFirst(perf.flats, overall.flats));
  const winrate = num(getFirst(perf.winrate, overall.winrate));
  const totalPnlPct = num(getFirst(perf.totalPnlPct, overall.totalPnlPct));
  const avgPnlPct = num(getFirst(perf.avgPnlPct, overall.avgPnlPct));
  const avgRR = num(getFirst(perf.avgRR, overall.avgRR));
  const avgConfluence = num(getFirst(perf.avgConfluence, overall.avgConfluence));

  if(!performanceData?.ok && !tradeStatsData?.ok){
    box.innerHTML = `
      <h2 class="runner-title">📊 Runner Performance</h2>
      <p style="color:var(--red);">Runner performance kon niet geladen worden.</p>
    `;
    return;
  }

  box.innerHTML = `
    <h2 class="runner-title">📊 Runner Performance</h2>
    <div class="runner-subtitle">
      Gesloten trade-log statistiek uit logger/db. Dit staat los van scanner-stage analytics.
    </div>

    <div class="metric-grid">
      ${renderMetric("Closed Trades", perfTotal)}
      ${renderMetric("Wins / Losses / Flat", `${wins} / ${losses} / ${flats}`)}
      ${renderMetric("Winrate", pctText(winrate), winrate >= 55 ? "good" : winrate > 0 && winrate < 45 ? "bad" : "")}
      ${renderMetric("Total PnL%", `${signedFixed(totalPnlPct, 3)}%`, valueClass(totalPnlPct))}

      ${renderMetric("Avg PnL%", `${signedFixed(avgPnlPct, 3)}%`, valueClass(avgPnlPct))}
      ${renderMetric("Avg RR", fixed(avgRR, 2))}
      ${renderMetric("Avg Confluence", fixed(avgConfluence, 2))}
      ${renderMetric("Hydrated", overall.hydrated === true || perf.hydrated === true ? "YES" : "NO")}
    </div>

    ${renderPerformanceRows("By Entry Type", stats.byEntryType)}
    ${renderPerformanceRows("By Side", stats.bySide)}
    ${renderPerformanceRows("By Flow", stats.byFlow)}
    ${renderPerformanceRows("By OB Bias", stats.byObBias)}
  `;
}

// ================= FUNNEL ANALYTICS =================
function block(title, data, side){
  if(!data) return "";

  const adviceId = `advice-${side}-${String(title || "").toLowerCase()}`;
  const stageKey = String(title || "").toLowerCase();
  const adviceList = window.latestAdvice?.[side]?.[stageKey] || [];

  const adviceHtml = adviceList.length
    ? adviceList.map(adviceItemToHtml).join("")
    : "<span style='color:var(--green);'>Runner scanner-flow normaal. Geen stage-aanpassing.</span>";

  const reasons = safeObject(data.reasons);

  return `
    <div class="analysis-card">
      <div class="a-header">
        <div class="a-title">${escapeHtml(title)}</div>
        <div class="a-total">Total: ${num(data.total)}</div>
      </div>

      <div class="a-stats">
        <div class="a-stat-row"><span class="a-stat-label">Good</span><span class="a-stat-val good">${escapeHtml(reasons.good || "0%")}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Low Score</span><span class="a-stat-val">${escapeHtml(reasons.lowScore || "0%")}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Weak Flow</span><span class="a-stat-val">${escapeHtml(reasons.weakFlow || "0%")}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Low Volume</span><span class="a-stat-val">${escapeHtml(reasons.lowVolume || "0%")}</span></div>
        <div class="a-stat-row"><span class="a-stat-label">Bad OB</span><span class="a-stat-val">${escapeHtml(reasons.badOB || "0%")}</span></div>
      </div>

      <div class="advice-content" id="${adviceId}">
        <strong>Runner Stage Advies</strong>
        ${adviceHtml}
      </div>

      <div class="advice-toggle-btn" onclick="toggleAdvice('${adviceId}')">
        Bekijk Runner Stage Advies
      </div>
    </div>
  `;
}

function renderFunnelAnalytics(data){
  const target = el("analytics");
  if(!target) return;

  const a = data?.analytics;

  if(!a){
    target.innerHTML = "<p style='color:var(--red);'>Geen runner analytics data gevonden.</p>";
    return;
  }

  let html = "";

  for(const side of ["bull", "bear"]){
    const color = side === "bull" ? "var(--green)" : "var(--red)";
    const icon = side === "bull" ? "🟢" : "🔴";

    html += `<h2 class="side-title" style="color:${color};">${icon} ${side.toUpperCase()} RUNNER FUNNEL</h2>`;

    for(const stage of ["entry", "almost", "buildup", "radar"]){
      if(a[side]?.[stage]){
        html += block(stage.toUpperCase(), a[side][stage], side);
      }
    }
  }

  target.innerHTML = html;
}

// ================= LOAD =================
async function load(){
  try{
    const [latest, performance, tradeStats] = await Promise.all([
      fetchJsonSafe("/api/public-latest"),
      fetchJsonSafe("/api/performance"),
      fetchJsonSafe("/api/trade-stats")
    ]);

    if(!latest?.ok){
      throw new Error(latest?.error || "public_latest_error");
    }

    const data = latest;

    window.latestAdvice = data.advice || {};

    const btcState = data?.btc?.state || "UNKNOWN";
    const btc24 = data?.btc?.chg24 !== undefined
      ? ` ${num(data.btc.chg24).toFixed(2)}%`
      : "";

    const regime = data?.regime || "UNKNOWN";
    const updated = data?.updatedAt || data?.storedAt || data?.servedAt;

    if(el("statusLine")){
      el("statusLine").innerText =
        `BTC: ${btcState}${btc24} | Regime: ${regime} | Laatste runner update: ${fmtTime(updated)} | Full: ${fmtDateTime(updated)}`;
    }

    renderGlobalAdvice(data);
    renderRunnerTelemetry(data);
    renderRunnerPerformance(performance, tradeStats);
    renderFunnelAnalytics(data);

  }catch(e){
    console.error("Runner analytics load error:", e);

    if(el("statusLine")){
      el("statusLine").innerText = `Runner analytics fout: ${e?.message || "unknown_error"}`;
    }

    if(el("globalAdvice")){
      el("globalAdvice").style.display = "block";
    }

    if(el("globalAdviceContent")){
      el("globalAdviceContent").innerHTML =
        `<span style="color:var(--red);">Runner latest payload kon niet geladen worden.</span>`;
    }

    if(el("runnerTelemetry")){
      el("runnerTelemetry").innerHTML = `
        <h2 class="runner-title">🚀 Runner Telemetry Engine</h2>
        <p style="color:var(--red);">Runner telemetry kon niet geladen worden.</p>
      `;
    }

    if(el("runnerPerformance")){
      el("runnerPerformance").innerHTML = `
        <h2 class="runner-title">📊 Runner Performance</h2>
        <p style="color:var(--red);">Runner performance kon niet geladen worden.</p>
      `;
    }

    if(el("analytics")){
      el("analytics").innerHTML =
        "<p style='color:var(--red);'>Fout bij laden van runner analytics.</p>";
    }
  }
}

setInterval(load, REFRESH_MS);
load();