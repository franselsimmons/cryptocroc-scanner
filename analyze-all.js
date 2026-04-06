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

function tableHtml(rows, columns) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) return `<div class="empty">Geen data</div>`;

  return `
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

function buildConfig(group) {
  const cfg = group?.liveConfig;
  if (!cfg) return `<div class="empty">Geen live config beschikbaar</div>`;

  const items = [];
  for (const [key, value] of Object.entries(cfg)) {
    items.push(`
      <div class="config-item">
        <div class="config-key">${esc(key)}</div>
        <div>${typeof value === "object" ? esc(JSON.stringify(value)) : esc(String(value))}</div>
      </div>
    `);
  }

  return items.length ? items.join("") : `<div class="empty">Geen live config beschikbaar</div>`;
}

function buildActionPlan(groupKey, group) {
  const lessons = Array.isArray(group?.teacher?.lessons) ? group.teacher.lessons : [];
  const score = n(group?.teacher?.score, 0);
  const byReason = group?.buckets?.byReason || [];
  const byStage = group?.buckets?.byStage || [];

  const timeoutRow = byReason.find((x) => String(x.key) === "timeout");
  const stopRow = byReason.find((x) => String(x.key) === "stop_loss");
  const thesisRow = byReason.find((x) => String(x.key) === "thesis_break");
  const weakStage = byStage.length ? [...byStage].sort((a, b) => n(a.avgPnlPct) - n(b.avgPnlPct))[0] : null;
  const bestStage = byStage.length ? [...byStage].sort((a, b) => n(b.avgPnlPct) - n(a.avgPnlPct))[0] : null;

  const items = [];

  items.push({
    title: "1. Eerst dit verbeteren",
    text:
      score < 5
        ? "Deze funnel scoort zwak. Zet de entry strenger, verlaag rommel-entries en focus eerst op setups met duidelijk betere structuur."
        : score < 7.5
          ? "Deze funnel is bruikbaar maar nog niet scherp genoeg. Werk vooral aan betere selectie en snellere afkapping van zwakke trades."
          : "Deze funnel presteert al redelijk sterk. Nu moet je fine-tunen in plaats van grote dingen slopen."
  });

  if (timeoutRow) {
    items.push({
      title: "2. Timeout aanpak",
      text: `Timeout heeft ${timeoutRow.count} trades met gemiddeld ${fmtPct(timeoutRow.avgPnlPct)}. Als dit negatief blijft, moet timeout korter of entry-selectie strenger worden.`
    });
  }

  if (stopRow) {
    items.push({
      title: "3. Stop-loss aanpak",
      text: `Stop-loss laat gemiddeld ${fmtPct(stopRow.avgPnlPct)} zien. Dat betekent meestal dat entries te los zijn of dat spread / orderbook / confidence strenger moeten.`
    });
  }

  if (thesisRow) {
    items.push({
      title: "4. Thesis-break gebruiken als leraar",
      text: `Thesis-break is nu gemiddeld ${fmtPct(thesisRow.avgPnlPct)}. Als die positief is, dan bewaart deze exit jouw winst beter dan te lang blijven zitten.`
    });
  }

  if (weakStage) {
    items.push({
      title: "5. Zwakste stage",
      text: `${weakStage.key} is nu de zwakste stage met gemiddeld ${fmtPct(weakStage.avgPnlPct)}. Daar moet je dus filters aanscherpen of minder vaak toelaten.`
    });
  }

  if (bestStage) {
    items.push({
      title: "6. Beste stage",
      text: `${bestStage.key} is nu de beste stage met gemiddeld ${fmtPct(bestStage.avgPnlPct)}. Gebruik deze als hoofd-lijn voor jouw funnel en probeer andere stages daar dichter naartoe te brengen.`
    });
  }

  if (groupKey === "moon_bull") {
    items.push({
      title: "7. Moon Bull richting",
      text: "Moon Bull moet minder losse ALMOST entries pakken en meer kwaliteit afdwingen voordat een trade open mag."
    });
  }

  if (groupKey === "moon_bear") {
    items.push({
      title: "7. Moon Bear richting",
      text: "Moon Bear heeft nog weinig trades. Hier moet je nog niet te hard op optimaliseren; eerst meer sample opbouwen."
    });
  }

  if (groupKey === "main_bull") {
    items.push({
      title: "7. Main Bull richting",
      text: "Main Bull moet vooral stop-loss en zwakke ignition entries reduceren. Beter minder trades, maar schonere entries."
    });
  }

  if (groupKey === "main_bear") {
    items.push({
      title: "7. Main Bear richting",
      text: "Main Bear is nu te dun en te zwak. Eerst entries veel strenger maken of tijdelijk bijna niets toelaten tot de bear-setup echt klopt."
    });
  }

  if (groupKey === "trade_funnel") {
    items.push({
      title: "7. Trade Funnel richting",
      text: "Gebruik trade funnel als overkoepelende leraar: alles wat structureel negatief is moet strenger, alles wat structureel positief is moet je zwaarder laten meetellen."
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

  document.getElementById("byReason").innerHTML = tableHtml(group?.buckets?.byReason, [
    { key: "key", label: "Reden" },
    { key: "count", label: "Trades" },
    { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
    { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
    { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) },
  ]);

  document.getElementById("byStage").innerHTML = tableHtml(group?.buckets?.byStage, [
    { key: "key", label: "Stage" },
    { key: "count", label: "Trades" },
    { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
    { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
    { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) },
  ]);

  document.getElementById("byEntryQuality").innerHTML = tableHtml(group?.buckets?.byEntryQuality, [
    { key: "key", label: "Bucket" },
    { key: "count", label: "Trades" },
    { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
    { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
  ]);

  document.getElementById("byPersistence").innerHTML = tableHtml(group?.buckets?.byPersistence, [
    { key: "key", label: "Bucket" },
    { key: "count", label: "Trades" },
    { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
    { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
  ]);

  document.getElementById("bySpread").innerHTML = tableHtml(group?.buckets?.bySpread, [
    { key: "key", label: "Bucket" },
    { key: "count", label: "Trades" },
    { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
    { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
  ]);

  document.getElementById("byObScore").innerHTML = tableHtml(group?.buckets?.byObScore, [
    { key: "key", label: "Bucket" },
    { key: "count", label: "Trades" },
    { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
    { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
  ]);

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