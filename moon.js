let mode = "bull";
let lastData = null;

const $ = (id) => document.getElementById(id);

function fmtNum(x, digits = 8) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(digits).replace(/\.?0+$/, "");
}

function fmtPct(x, digits = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function fmtConf(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return v <= 1 ? fmtNum(v, 3) : fmtNum(v, 1);
}

function setStatus(text, kind = "idle") {
  const el = $("moon-status");
  if (!el) return;
  el.textContent = `Status: ${text}`;
  el.dataset.kind = kind;
}

function setMode(nextMode) {
  mode = nextMode === "bear" ? "bear" : "bull";

  $("btn-bull")?.classList.toggle("active", mode === "bull");
  $("btn-bear")?.classList.toggle("active", mode === "bear");

  fetchMoonData();
}

function renderList(containerId, items, renderer, emptyText = "Geen coins.") {
  const el = $(containerId);
  if (!el) return;

  if (!Array.isArray(items) || items.length === 0) {
    el.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }

  el.innerHTML = items.map(renderer).join("");
}

function getPrimaryProbability(c) {
  if (mode === "bear") {
    return Number(c?.dumpProbability ?? 0);
  }
  return Number(c?.moonProbability ?? 0);
}

function renderCoinCard(c) {
  const prob = getPrimaryProbability(c);
  const probLabel = mode === "bear" ? "Dump prob" : "Moon prob";

  return `
    <article class="coin-card">
      <div class="coin-card-top">
        <div>
          <div class="coin-symbol">${c.symbol || "-"}</div>
          <div class="coin-name">${c.name || ""}</div>
        </div>
        <div class="coin-price">$${fmtNum(c.price, 8)}</div>
      </div>

      <div class="coin-grid">
        <div><span>24h</span><strong>${fmtPct(c.change24, 2)}</strong></div>
        <div><span>VM</span><strong>${fmtNum(c.vm, 3)}</strong></div>
        <div><span>Conf</span><strong>${fmtConf(c.confidence)}</strong></div>
        <div><span>${probLabel}</span><strong>${fmtNum(prob, 3)}</strong></div>
      </div>

      <div class="coin-grid">
        <div><span>Spread</span><strong>${fmtNum(c?.ob?.spreadPct, 3)}%</strong></div>
        <div><span>OB score</span><strong>${fmtNum(c?.ob?.score, 5)}</strong></div>
        <div><span>Depth</span><strong>${fmtNum(c?.ob?.depthMinUsd1p, 0)}</strong></div>
        <div><span>Edge</span><strong>${fmtNum(c?.edgeScore, 1)}</strong></div>
      </div>

      ${
        c?.tradePlan
          ? `
          <div class="trade-plan">
            <div><span>Entry</span><strong>$${fmtNum(c.tradePlan.entry, 8)}</strong></div>
            <div><span>SL</span><strong>$${fmtNum(c.tradePlan.sl, 8)}</strong></div>
            <div><span>TP</span><strong>$${fmtNum(c.tradePlan.tp, 8)}</strong></div>
            <div><span>RR</span><strong>${fmtNum(c.tradePlan.rr, 2)}</strong></div>
          </div>
        `
          : ""
      }
    </article>
  `;
}

function renderPortfolio(portfolio, btc, whaleFlow) {
  const el = $("moon-portfolio");
  if (!el) return;

  if (!portfolio && !btc) {
    el.innerHTML = `<div class="empty">Geen data.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="portfolio-wrap">
      <div class="portfolio-block">
        <div class="portfolio-title">BTC</div>
        <div><strong>State:</strong> ${btc?.state || "-"}</div>
        <div><strong>24h:</strong> ${fmtPct(btc?.chg24, 3)}</div>
        <div><strong>Range:</strong> ${fmtPct(btc?.range24, 3)}</div>
      </div>

      ${
        portfolio
          ? `
          <div class="portfolio-block">
            <div class="portfolio-title">Portfolio</div>
            <div><strong>Open:</strong> ${portfolio.openCount ?? 0}</div>
            <div><strong>Closed:</strong> ${portfolio.closedCount ?? 0}</div>
            <div><strong>Realized:</strong> $${fmtNum(portfolio.realizedUsd, 2)}</div>
            <div><strong>Avg realized:</strong> ${fmtPct(portfolio.avgRealizedPct, 2)}</div>
          </div>
        `
          : `<div class="empty">Geen portfolio data.</div>`
      }

      ${
        whaleFlow != null
          ? `
          <div class="portfolio-block">
            <div class="portfolio-title">Market flow</div>
            <div><strong>Whale flow:</strong> ${fmtNum(whaleFlow, 0)}</div>
            <div><strong>Mode:</strong> ${mode.toUpperCase()}</div>
          </div>
        `
          : ""
      }
    </div>
  `;
}

function renderData(data) {
  lastData = data;

  renderList(
    "moon-elite-list",
    data?.funnel?.elite || [],
    renderCoinCard,
    mode === "bear" ? "Geen bear ELITE coins." : "Geen bull ELITE coins."
  );

  renderList(
    "moon-almost-list",
    data?.funnel?.almost || [],
    renderCoinCard,
    mode === "bear" ? "Geen bear ALMOST coins." : "Geen bull ALMOST coins."
  );

  renderList(
    "moon-buildup-list",
    data?.funnel?.buildup || [],
    renderCoinCard,
    mode === "bear" ? "Geen bear BUILDUP coins." : "Geen bull BUILDUP coins."
  );

  renderList(
    "moon-radar-list",
    data?.funnel?.radar || [],
    renderCoinCard,
    mode === "bear" ? "Geen bear RADAR coins." : "Geen bull RADAR coins."
  );

  renderPortfolio(data?.portfolio || null, data?.btc || null, data?.whaleFlow);

  if (data?.ok === false) {
    setStatus(data.error || "error", "error");
    return;
  }

  const eliteCount = data?.counts?.elite ?? 0;
  const almostCount = data?.counts?.almost ?? 0;
  const buildupCount = data?.counts?.buildup ?? 0;
  const radarCount = data?.counts?.radar ?? 0;

  const label = mode === "bear" ? "BEAR" : "BULL";

  setStatus(
    `ok • ${label} • ELITE ${eliteCount} • ALMOST ${almostCount} • BUILDUP ${buildupCount} • RADAR ${radarCount}`,
    "ok"
  );
}

function renderError(message) {
  setStatus("error", "error");

  const err = String(message || "Onbekende fout");

  $("moon-elite-list").innerHTML = `<div class="error-box">Scan fout: ${err}</div>`;
  $("moon-almost-list").innerHTML = `<div class="empty">Geen data.</div>`;
  $("moon-buildup-list").innerHTML = `<div class="empty">Geen data.</div>`;
  $("moon-radar-list").innerHTML = `<div class="empty">Geen data.</div>`;
  $("moon-portfolio").innerHTML = `<div class="error-box">Scan fout: ${err}</div>`;
}

async function fetchMoonData() {
  setStatus("laden...", "loading");

  try {
    const res = await fetch(`/api/moon/public-latest?mode=${mode}`, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    });

    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Ongeldige JSON: ${text.slice(0, 200)}`);
    }

    if (!res.ok || json?.ok === false) {
      throw new Error(json?.error || `HTTP ${res.status}`);
    }

    renderData(json);
  } catch (e) {
    renderError(e?.message || e);
  }
}

function initMoonPage() {
  $("btn-bull")?.addEventListener("click", () => setMode("bull"));
  $("btn-bear")?.addEventListener("click", () => setMode("bear"));
  $("btn-refresh")?.addEventListener("click", () => fetchMoonData());

  $("btn-scan")?.addEventListener("click", () => {
    alert("Moon scan loopt automatisch elke 15 minuten.");
  });

  fetchMoonData();
  setInterval(fetchMoonData, 60000);
}

document.addEventListener("DOMContentLoaded", initMoonPage);