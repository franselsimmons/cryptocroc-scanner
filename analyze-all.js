function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function fmtPct(v) {
  return `${n(v, 0).toFixed(2)}%`;
}

function fmtUsd(v) {
  return `$${n(v, 0).toFixed(2)}`;
}

function fmtTs(ts) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString("nl-NL");
  } catch {
    return "-";
  }
}

function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function badgeClass(score) {
  const s = n(score, 0);
  if (s >= 7.5) return "good";
  if (s >= 5) return "mid";
  return "bad";
}

function tableHtml(rows, columns, helpText = "") {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    return `
      ${helpText ? `<div class="table-help">${esc(helpText)}</div>` : ""}
      <div class="empty">Geen data</div>
    `;
  }

  return `
    ${helpText ? `<div class="table-help">${esc(helpText)}</div>` : ""}
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            ${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${safeRows.map((row) => `
            <tr>
              ${columns.map((c) => `<td>${c.render ? c.render(row) : esc(row?.[c.key])}</td>`).join("")}
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function buildStatsGrid(data) {
  const groups = data?.groups || {};
  const moonBull = groups.moon_bull?.summary || {};
  const moonBear = groups.moon_bear?.summary || {};
  const mainBull = groups.main_bull?.summary || {};
  const mainBear = groups.main_bear?.summary || {};
  const tradeFunnel = groups.trade_funnel?.summary || {};

  return `
    <div class="stat-card">
      <div class="stat-title">Moon Bull score</div>
      <div class="stat-value">${n(groups.moon_bull?.teacher?.score, 0).toFixed(2)}</div>
      <div class="stat-sub">Winrate ${fmtPct(moonBull.winRate)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-title">Moon Bear score</div>
      <div class="stat-value">${n(groups.moon_bear?.teacher?.score, 0).toFixed(2)}</div>
      <div class="stat-sub">Winrate ${fmtPct(moonBear.winRate)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-title">Main Bull score</div>
      <div class="stat-value">${n(groups.main_bull?.teacher?.score, 0).toFixed(2)}</div>
      <div class="stat-sub">Winrate ${fmtPct(mainBull.winRate)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-title">Main Bear score</div>
      <div class="stat-value">${n(groups.main_bear?.teacher?.score, 0).toFixed(2)}</div>
      <div class="stat-sub">Winrate ${fmtPct(mainBear.winRate)}</div>
    </div>
    <div class="stat-card">
      <div class="stat-title">Trade Funnel score</div>
      <div class="stat-value">${n(groups.trade_funnel?.teacher?.score, 0).toFixed(2)}</div>
      <div class="stat-sub">Winrate ${fmtPct(tradeFunnel.winRate)}</div>
    </div>
  `;
}

function buildSummary(group) {
  const summary = group?.summary || {};
  const teacherScore = n(group?.teacher?.score, 0);

  return `
    <div class="summary-box">
      <div class="summary-label">Teacher score</div>
      <div class="summary-value">
        ${teacherScore.toFixed(2)}
        <span class="badge ${badgeClass(teacherScore)}">${teacherScore >= 7.5 ? "sterk" : teacherScore >= 5 ? "matig" : "zwak"}</span>
      </div>
    </div>
    <div class="summary-box">
      <div class="summary-label">Trades</div>
      <div class="summary-value">${n(summary.trades, 0)}</div>
    </div>
    <div class="summary-box">
      <div class="summary-label">Wins / Losses</div>
      <div class="summary-value">${n(summary.wins, 0)} / ${n(summary.losses, 0)}</div>
    </div>
    <div class="summary-box">
      <div class="summary-label">Winrate</div>
      <div class="summary-value">${fmtPct(summary.winRate)}</div>
    </div>
    <div class="summary-box">
      <div class="summary-label">Totale PnL USD</div>
      <div class="summary-value">${fmtUsd(summary.totalPnlUsd)}</div>
    </div>
    <div class="summary-box">
      <div class="summary-label">Gemiddelde PnL %</div>
      <div class="summary-value">${fmtPct(summary.avgPnlPct)}</div>
    </div>
  `;
}

function buildLessons(group) {
  const lessons = Array.isArray(group?.teacher?.lessons) ? group.teacher.lessons : [];
  if (!lessons.length) return `<div class="empty">Geen lessen gevonden</div>`;

  return lessons.map((lesson) => `
    <div class="lesson ${esc(lesson.type)}">
      <div class="lesson-type">${esc(lesson.type)}</div>
      <div>${esc(lesson.text)}</div>
    </div>
  `).join("");
}

function flattenConfig(cfg, prefix = "") {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return [];
  const out = [];

  for (const [key, value] of Object.entries(cfg)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenConfig(value, path));
    } else {
      out.push({ key: path, value });
    }
  }

  return out;
}

function buildConfig(group) {
  const cfg = group?.liveConfig;
  if (!cfg) return `<div class="empty">Geen live config beschikbaar</div>`;

  const flattened = flattenConfig(cfg);
  if (!flattened.length) return `<div class="empty">Geen live config beschikbaar</div>`;

  const priorityKeys = [
    "radar.volMin",
    "radar.vmMin",
    "radar.mcapMin",
    "radar.mcapMax",
    "buildup.minVolAcc",
    "almost.minConfidence",
    "almost.maxFlat60Pct",
    "entry.minConfidence",
    "entry.spreadMaxPct",
    "entry.depthMinUsd1p",
    "entry.obScoreMin",
    "entry.samplesMax",
    "desk.minBreakoutPressure",
    "exits.timeoutBars",
    "exits.timeoutMinNetPnlPct"
  ];

  const quickStats = priorityKeys
    .map((k) => flattened.find((x) => x.key === k))
    .filter(Boolean);

  return `
    <div class="config-grid">
      ${quickStats.map((item) => `
        <div class="config-stat">
          <div class="config-stat-label">${esc(item.key)}</div>
          <div class="config-stat-value">${esc(String(item.value ?? "-"))}</div>
        </div>
      `).join("")}
    </div>

    <details class="details-box">
      <summary>Toon volledige live config</summary>
      <pre class="pre">${esc(JSON.stringify(cfg, null, 2))}</pre>
    </details>
  `;
}

function buildDataQuality(group) {
  const dq = group?.dataQuality || {};
  return `
    <div class="quality-box">
      <div class="quality-label">Closed trades totaal</div>
      <div class="quality-value">${n(dq.totalClosedTrades, 0)}</div>
    </div>
    <div class="quality-box">
      <div class="quality-label">Rich trades</div>
      <div class="quality-value">${n(dq.richClosedTrades, 0)}</div>
    </div>
    <div class="quality-box">
      <div class="quality-label">Rich coverage</div>
      <div class="quality-value">${fmtPct(dq.richCoveragePct)}</div>
    </div>
  `;
}

function buildActionPlan(groupKey, group) {
  const lessons = Array.isArray(group?.teacher?.lessons) ? group.teacher.lessons : [];
  const score = n(group?.teacher?.score, 0);
  const byReason = group?.buckets?.byReason || [];
  const byStage = group?.buckets?.byStage || [];
  const byEntryQuality = group?.buckets?.byEntryQuality || [];
  const byPersistence = group?.buckets?.byPersistence || [];
  const bySpread = group?.buckets?.bySpread || [];

  const timeoutRow = byReason.find((x) => String(x.key) === "timeout");
  const stopRow = byReason.find((x) => String(x.key) === "stop_loss" || String(x.key) === "sl");
  const thesisRow = byReason.find((x) => String(x.key) === "thesis_break");
  const weakStage = byStage.length ? [...byStage].sort((a, b) => n(a.avgPnlPct) - n(b.avgPnlPct))[0] : null;
  const bestStage = byStage.length ? [...byStage].sort((a, b) => n(b.avgPnlPct) - n(a.avgPnlPct))[0] : null;
  const bestEq = byEntryQuality.length ? [...byEntryQuality].sort((a, b) => n(b.avgPnlPct) - n(a.avgPnlPct))[0] : null;
  const bestPs = byPersistence.length ? [...byPersistence].sort((a, b) => n(b.avgPnlPct) - n(a.avgPnlPct))[0] : null;
  const bestSpread = bySpread.length ? [...bySpread].sort((a, b) => n(b.avgPnlPct) - n(a.avgPnlPct))[0] : null;

  const items = [];

  items.push({
    title: "1. Hoofdconclusie",
    text:
      score < 5
        ? "Deze funnel scoort zwak. Focus eerst op strengere entries en minder rommel-trades."
        : score < 7.5
          ? "Deze funnel is bruikbaar, maar nog niet strak genoeg. Verbeter vooral selectie en exits."
          : "Deze funnel is al sterk. Nu draait het om fijne optimalisatie in plaats van grote ingrepen."
  });

  if (bestStage) {
    items.push({
      title: "2. Beste stage",
      text: `${bestStage.key} is nu de sterkste stage met gemiddeld ${fmtPct(bestStage.avgPnlPct)}. Dat is je referentiepunt.`
    });
  }

  if (weakStage) {
    items.push({
      title: "3. Zwakste stage",
      text: `${weakStage.key} is nu de zwakste stage met gemiddeld ${fmtPct(weakStage.avgPnlPct)}. Daar moet je filters strenger maken of minder trades toelaten.`
    });
  }

  if (bestEq) {
    items.push({
      title: "4. Entry quality",
      text: `Beste bucket is ${bestEq.key}. Gebruik dit als richting voor minimale entry-kwaliteit.`
    });
  }

  if (bestPs) {
    items.push({
      title: "5. Persistence",
      text: `Beste persistence-bucket is ${bestPs.key}. Dat laat zien waar de hoofd-lijn van kwaliteit zit.`
    });
  }

  if (bestSpread) {
    items.push({
      title: "6. Spread",
      text: `Beste spread-bucket is ${bestSpread.key}. Alles daarbuiten moet je kritischer bekijken.`
    });
  }

  if (timeoutRow) {
    items.push({
      title: "7. Timeout",
      text: `Timeout heeft ${timeoutRow.count} trades met gemiddeld ${fmtPct(timeoutRow.avgPnlPct)}. Als dat negatief blijft, timeout verkorten of kwaliteit vóór entry verhogen.`
    });
  }

  if (stopRow) {
    items.push({
      title: "8. Stop-loss",
      text: `Stop-loss laat gemiddeld ${fmtPct(stopRow.avgPnlPct)} zien. Dat wijst meestal op te losse entry-selectie of te zwakke spread / OB filtering.`
    });
  }

  if (thesisRow) {
    items.push({
      title: "9. Thesis-break",
      text: `Thesis-break doet gemiddeld ${fmtPct(thesisRow.avgPnlPct)}. Als dit positief is, bewaart deze exit winst beter dan te lang vasthouden.`
    });
  }

  if (groupKey === "moon_bull") {
    items.push({
      title: "10. Funnel focus",
      text: "Moon Bull moet vooral voorkomen dat teveel middelmatige setups door ALMOST heen naar een trade gaan."
    });
  } else if (groupKey === "moon_bear") {
    items.push({
      title: "10. Funnel focus",
      text: "Moon Bear heeft vaak minder sample. Optimaliseer hier pas hard als de dataset groter is."
    });
  } else if (groupKey === "main_bull") {
    items.push({
      title: "10. Funnel focus",
      text: "Main Bull moet vooral stop-loss clusters en zwakke ignition-achtige setups verder reduceren."
    });
  } else if (groupKey === "main_bear") {
    items.push({
      title: "10. Funnel focus",
      text: "Main Bear moet voorlopig zeer streng blijven tot er genoeg bewijs is welke setups echt werken."
    });
  } else if (groupKey === "trade_funnel") {
    items.push({
      title: "10. Funnel focus",
      text: "Trade Funnel is je overkoepelende leraar. Wat structureel slecht is moet strenger, wat structureel goed is moet zwaarder meewegen."
    });
  }

  if (lessons.length) {
    items.push({
      title: "11. Teacher samenvatting",
      text: lessons.map((x) => x.text).join(" ")
    });
  }

  return items.map((item) => `
    <div class="action-item">
      <h3>${esc(item.title)}</h3>
      <p>${esc(item.text)}</p>
    </div>
  `).join("");
}

function renderGroup(groupKey, data) {
  const group = data?.groups?.[groupKey];
  if (!group) return;

  document.getElementById("groupSummary").innerHTML = buildSummary(group);
  document.getElementById("teacherLessons").innerHTML = buildLessons(group);
  document.getElementById("liveConfigBox").innerHTML = buildConfig(group);
  document.getElementById("dataQualityBox").innerHTML = buildDataQuality(group);

  document.getElementById("byReason").innerHTML = tableHtml(
    group?.buckets?.byReason,
    [
      { key: "key", label: "Reden" },
      { key: "count", label: "Trades" },
      { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
      { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
      { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) }
    ],
    "Hier zie je welke exit-redenen winst of verlies veroorzaken."
  );

  document.getElementById("byStage").innerHTML = tableHtml(
    group?.buckets?.byStage,
    [
      { key: "key", label: "Stage" },
      { key: "count", label: "Trades" },
      { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
      { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
      { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) }
    ],
    "Hier zie je welke funnel-stage gemiddeld het beste werkt."
  );

  document.getElementById("byEntryQuality").innerHTML = tableHtml(
    group?.buckets?.byEntryQuality,
    [
      { key: "key", label: "Bucket" },
      { key: "count", label: "Trades" },
      { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
      { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) }
    ],
    "Hier zie je of hogere entry quality echt beter presteert."
  );

  document.getElementById("byPersistence").innerHTML = tableHtml(
    group?.buckets?.byPersistence,
    [
      { key: "key", label: "Bucket" },
      { key: "count", label: "Trades" },
      { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
      { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) }
    ],
    "Hier zie je of persistence een sterk filter is."
  );

  document.getElementById("bySpread").innerHTML = tableHtml(
    group?.buckets?.bySpread,
    [
      { key: "key", label: "Spread bucket" },
      { key: "count", label: "Trades" },
      { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
      { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) }
    ],
    "Hier zie je bij welke spread-range de resultaten beter zijn."
  );

  document.getElementById("byObScore").innerHTML = tableHtml(
    group?.buckets?.byObScore,
    [
      { key: "key", label: "OB bucket" },
      { key: "count", label: "Trades" },
      { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
      { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) }
    ],
    "Hier zie je of orderbook-score echt predictive is."
  );

  document.getElementById("actionPlan").innerHTML = buildActionPlan(groupKey, group);
}

async function load() {
  const loadingBox = document.getElementById("loadingBox");
  const errorBox = document.getElementById("errorBox");
  const app = document.getElementById("app");
  const statsGrid = document.getElementById("statsGrid");
  const lastUpdated = document.getElementById("lastUpdated");

  try {
    loadingBox.classList.remove("hidden");
    errorBox.classList.add("hidden");
    app.classList.add("hidden");

    const res = await fetch("/api/analyze-all", { cache: "no-store" });
    const json = await res.json();

    if (!json?.ok) {
      throw new Error(json?.error || "Laden mislukt");
    }

    window.__analyzeAllData = json;

    statsGrid.innerHTML = buildStatsGrid(json);
    lastUpdated.textContent = `Laatste refresh: ${fmtTs(json?.ts)}`;

    renderGroup("moon_bull", json);

    loadingBox.classList.add("hidden");
    app.classList.remove("hidden");
  } catch (err) {
    loadingBox.classList.add("hidden");
    errorBox.classList.remove("hidden");
    errorBox.textContent = err?.message || "Onbekende fout";
  }
}

function bindTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      btn.classList.add("active");
      renderGroup(btn.dataset.group, window.__analyzeAllData || {});
    });
  });
}

document.getElementById("refreshBtn").addEventListener("click", load);
bindTabs();
load();