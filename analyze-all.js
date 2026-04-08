function el(id) {
  return document.getElementById(id);
}

function setHtml(id, html) {
  const node = el(id);
  if (node) node.innerHTML = html;
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

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

function adjustmentTone(score) {
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
          ${safeRows
            .map(
              (row) => `
            <tr>
              ${columns
                .map((c) => `<td>${c.render ? c.render(row) : esc(row?.[c.key])}</td>`)
                .join("")}
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function buildTopPriorities(data) {
  const overview = data?.overview || {};
  const order = ["trade_funnel", "moon_bull", "moon_bear", "main_bull", "main_bear"];

  const titleMap = {
    trade_funnel: "Trade Funnel",
    moon_bull: "Moon Bull",
    moon_bear: "Moon Bear",
    main_bull: "Main Bull",
    main_bear: "Main Bear",
  };

  return `
    <section class="panel">
      <h2>Eerste aanpassing per funnel</h2>
      <div class="priority-grid">
        ${order
          .map((key) => {
            const item = overview?.[key];
            if (!item) return "";

            const adj = item.topAdjustment || {};
            const tone = adjustmentTone(item.score);

            return `
              <div class="priority-card ${tone}">
                <div class="priority-head">
                  <div class="priority-name">${esc(titleMap[key] || key)}</div>
                  <div class="priority-score">Score ${n(item.score, 0).toFixed(2)}</div>
                </div>

                <div class="priority-action">${esc(adj.title || "Nog geen harde wijziging")}</div>
                <div class="priority-text">${esc(adj.shortText || "Nog geen duidelijke eerste aanpassing.")}</div>
                <div class="priority-meta">
                  Trades ${n(item.trades, 0)} • Winrate ${fmtPct(item.winRate)} • Avg ${fmtPct(item.avgPnlPct)}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    </section>
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
        <span class="badge ${badgeClass(teacherScore)}">${
          teacherScore >= 7.5 ? "sterk" : teacherScore >= 5 ? "matig" : "zwak"
        }</span>
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

  return lessons
    .map(
      (lesson) => `
      <div class="lesson ${esc(lesson.type)}">
        <div class="lesson-type">${esc(lesson.type)}</div>
        <div>${esc(lesson.text)}</div>
      </div>
    `
    )
    .join("");
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

function buildConfig(groupKey, group) {
  const cfg = group?.liveConfig;

  if (!cfg) return `<div class="empty">Geen live config beschikbaar</div>`;

  if (cfg.kind === "aggregate") {
    return `<div class="empty">${esc(cfg.note || "Samengestelde groep zonder eigen live config.")}</div>`;
  }

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
    "desk.minBreakoutPressure",
    "exits.timeoutBars",
    "exits.timeoutMinNetPnlPct",
  ];

  const quickStats = priorityKeys
    .map((k) => flattened.find((x) => x.key === k))
    .filter(Boolean);

  const suggestions = Array.isArray(group?.teacher?.suggestions) ? group.teacher.suggestions : [];

  return `
    ${
      quickStats.length
        ? `
      <div class="config-grid">
        ${quickStats
          .map(
            (item) => `
          <div class="config-stat">
            <div class="config-stat-label">${esc(item.key)}</div>
            <div class="config-stat-value">${esc(String(item.value ?? "-"))}</div>
          </div>
        `
          )
          .join("")}
      </div>
    `
        : `<div class="empty">Geen prioriteitsvelden gevonden</div>`
    }

    ${
      suggestions.length
        ? `
      <div class="details-box">
        <div class="table-help">Automatische concrete suggesties op basis van live config + eventdata.</div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Pad</th>
                <th>Huidig</th>
                <th>Suggestie</th>
                <th>Richting</th>
              </tr>
            </thead>
            <tbody>
              ${suggestions
                .map(
                  (s) => `
                <tr>
                  <td>${esc(s.path)}</td>
                  <td>${esc(String(s.current))}</td>
                  <td>${esc(String(s.suggested))}</td>
                  <td>${esc(String(s.direction))}</td>
                </tr>
              `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `
        : ""
    }

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
    <div class="quality-box">
      <div class="quality-label">Analysebron</div>
      <div class="quality-value">${dq.usingRichRows ? "Rich rows" : "Alle rows"}</div>
    </div>
  `;
}

function buildFunnelBlockers(group) {
  const stuckStats = group?.funnelBlockers?.stuckStats || [];
  return tableHtml(
    stuckStats,
    [
      { key: "group", label: "Group", render: (r) => esc(r.group || "-") },
      { key: "stage", label: "Stage" },
      { key: "seenCoins", label: "Coins gezien" },
      { key: "laterStrongCoins", label: "Later sterk" },
      {
        key: "stuckButLaterStrongRate",
        label: "Rate",
        render: (r) => fmtPct(r.stuckButLaterStrongRate),
      },
    ],
    "Hier zie je in welke funnel-stage coins relatief vaak blijven hangen terwijl ze later toch sterk blijken."
  );
}

function buildFunnelBlockerLessons(group) {
  const lessons = group?.funnelBlockers?.lessons || [];
  if (!lessons.length) return `<div class="empty">Nog geen funnel blocker lessen</div>`;

  return lessons
    .map(
      (lesson) => `
      <div class="lesson ${esc(lesson.type)}">
        <div class="lesson-type">${esc(lesson.type)}</div>
        <div>${esc(lesson.text)}</div>
      </div>
    `
    )
    .join("");
}

function buildActionPlan(groupKey, group) {
  const summary = group?.summary || {};
  const teacher = group?.teacher || {};
  const topAdjustment = group?.topAdjustment || null;
  const suggestions = Array.isArray(teacher?.suggestions) ? teacher.suggestions : [];
  const byStage = group?.buckets?.byStage || [];
  const byReason = group?.buckets?.byReason || [];

  const items = [];

  if (topAdjustment) {
    items.push({
      title: "Eerste aanpassing",
      text: topAdjustment.longText || topAdjustment.shortText || "Nog geen duidelijke eerste aanpassing.",
    });
  }

  if (n(summary.trades, 0) < 5) {
    items.push({
      title: "Sample te klein",
      text: `Er zijn pas ${summary.trades} closed trades. Zie optimalisaties nu als voorlopig.`,
    });
  }

  const bestStage = [...byStage]
    .filter((x) => n(x.count, 0) >= 1)
    .sort((a, b) => n(b.avgPnlPct, 0) - n(a.avgPnlPct, 0))[0];

  const worstStage = [...byStage]
    .filter((x) => n(x.count, 0) >= 1)
    .sort((a, b) => n(a.avgPnlPct, 0) - n(b.avgPnlPct, 0))[0];

  if (bestStage) {
    items.push({
      title: "Beste stage",
      text: `${bestStage.key} is nu de sterkste stage met gemiddeld ${fmtPct(bestStage.avgPnlPct)}.`,
    });
  }

  if (worstStage && worstStage.key !== bestStage?.key) {
    items.push({
      title: "Zwakste stage",
      text: `${worstStage.key} is nu de zwakste stage met gemiddeld ${fmtPct(worstStage.avgPnlPct)}.`,
    });
  }

  for (const s of suggestions) {
    items.push({
      title: `Concrete filter-aanpassing: ${s.path}`,
      text: `Verander ${s.path} van ${s.current} naar ongeveer ${s.suggested}. Reden: ${s.reason}.`,
    });
  }

  const stopLoss = byReason.find((x) => x.key === "stop_loss");
  const timeout = byReason.find((x) => x.key === "timeout");
  const thesisBreak = byReason.find((x) => x.key === "thesis_break");

  if (stopLoss) {
    items.push({
      title: "Stop-loss patroon",
      text: `Stop-loss laat gemiddeld ${fmtPct(stopLoss.avgPnlPct)} zien over ${stopLoss.count} trades.`,
    });
  }

  if (timeout) {
    items.push({
      title: "Timeout patroon",
      text: `Timeout laat gemiddeld ${fmtPct(timeout.avgPnlPct)} zien over ${timeout.count} trades.`,
    });
  }

  if (thesisBreak) {
    items.push({
      title: "Thesis-break patroon",
      text: `Thesis-break laat gemiddeld ${fmtPct(thesisBreak.avgPnlPct)} zien over ${thesisBreak.count} trades.`,
    });
  }

  if (!items.length) {
    items.push({
      title: "Nog geen harde aanpassing",
      text: "Er is nog niet genoeg betrouwbare data om een concrete filterwijziging voor te stellen.",
    });
  }

  return items
    .map(
      (item) => `
      <div class="action-item">
        <h3>${esc(item.title)}</h3>
        <p>${esc(item.text)}</p>
      </div>
    `
    )
    .join("");
}

function renderGroup(groupKey, data) {
  const group = data?.groups?.[groupKey];
  if (!group) return;

  setHtml("groupSummary", buildSummary(group));
  setHtml("teacherLessons", buildLessons(group));
  setHtml("liveConfigBox", buildConfig(groupKey, group));
  setHtml("dataQualityBox", buildDataQuality(group));
  setHtml("funnelBlockers", buildFunnelBlockers(group));
  setHtml("funnelBlockerLessons", buildFunnelBlockerLessons(group));

  setHtml(
    "byReason",
    tableHtml(
      group?.buckets?.byReason,
      [
        { key: "key", label: "Reden" },
        { key: "count", label: "Trades" },
        { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
        { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
        { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) },
      ],
      "Hier zie je welke exit-redenen winst of verlies veroorzaken."
    )
  );

  setHtml(
    "byStage",
    tableHtml(
      group?.buckets?.byStage,
      [
        { key: "key", label: "Stage" },
        { key: "count", label: "Trades" },
        { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
        { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
        { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) },
      ],
      "Hier zie je welke funnel-stage gemiddeld het beste werkt."
    )
  );

  setHtml(
    "byEntryQuality",
    tableHtml(
      group?.buckets?.byEntryQuality,
      [
        { key: "key", label: "Bucket" },
        { key: "count", label: "Trades" },
        { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
        { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
      ],
      "Hier zie je of hogere entry quality echt beter presteert."
    )
  );

  setHtml(
    "byPersistence",
    tableHtml(
      group?.buckets?.byPersistence,
      [
        { key: "key", label: "Bucket" },
        { key: "count", label: "Trades" },
        { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
        { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
      ],
      "Hier zie je of persistence een sterk filter is."
    )
  );

  setHtml(
    "bySpread",
    tableHtml(
      group?.buckets?.bySpread,
      [
        { key: "key", label: "Spread bucket" },
        { key: "count", label: "Trades" },
        { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
        { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
      ],
      "Hier zie je bij welke spread-range de resultaten beter zijn."
    )
  );

  setHtml(
    "byObScore",
    tableHtml(
      group?.buckets?.byObScore,
      [
        { key: "key", label: "OB bucket" },
        { key: "count", label: "Trades" },
        { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
        { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
      ],
      "Hier zie je of orderbook-score echt predictive is."
    )
  );

  setHtml("actionPlan", buildActionPlan(groupKey, group));
}

async function load() {
  const loadingBox = el("loadingBox");
  const errorBox = el("errorBox");
  const app = el("app");

  try {
    if (loadingBox) loadingBox.classList.remove("hidden");
    if (errorBox) errorBox.classList.add("hidden");
    if (app) app.classList.add("hidden");

    const res = await fetch("/api/analyze-all", { cache: "no-store" });
    const json = await res.json();

    if (!res.ok || !json?.ok) {
      throw new Error(json?.error || "Laden mislukt");
    }

    window.__analyzeAllData = json;

    setHtml("topPriorities", buildTopPriorities(json));
    setHtml("statsGrid", buildStatsGrid(json));
    setText("lastUpdated", `Laatste refresh: ${fmtTs(json?.ts)}`);

    renderGroup("moon_bull", json);

    if (loadingBox) loadingBox.classList.add("hidden");
    if (app) app.classList.remove("hidden");
  } catch (err) {
    if (loadingBox) loadingBox.classList.add("hidden");
    if (errorBox) {
      errorBox.classList.remove("hidden");
      errorBox.textContent = err?.message || "Onbekende fout";
    }
    console.error("Analyze All load error:", err);
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

function initAnalyzeAll() {
  const refreshBtn = el("refreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", load);
  }

  bindTabs();
  load();
}

document.addEventListener("DOMContentLoaded", initAnalyzeAll);