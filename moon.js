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

function renderList(containerId, items, renderer) {
  const el = $(containerId);
  if (!el) return;

  if (!Array.isArray(items) || items.length === 0) {
    el.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }

  el.innerHTML = items.map(renderer).join("");
}

function renderCoinCard(c) {
  return `
    <div class="coin-row">
      <div class="coin-head">
        <div class="coin-symbol">${c.symbol || "-"}</div>
        <div class="coin-price">$${fmtNum(c.price, 8)}</div>
      </div>
      <div class="coin-meta">
        <span>24h: ${fmtPct(c.change24, 2)}</span>
        <span>VM: ${fmtNum(c.vm, 3)}</span>
        <span>Conf: ${c.confidence ?? "-"}</span>
      </div>
    </div>
  `;
}

function renderPortfolio(portfolio, btc) {
  const el = $("moon-portfolio");
  if (!el) return;

  if (!portfolio && !btc) {
    el.innerHTML = `<div class="empty">Geen data.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="portfolio-block">
      <div><strong>BTC:</strong> ${btc?.state || "-"}</div>
      <div><strong>24h:</strong> ${fmtPct(btc?.chg24, 3)}</div>
      <div><strong>Range:</strong> ${fmtPct(btc?.range24, 3)}</div>
    </div>
    ${
      portfolio
        ? `
        <div class="portfolio-block">
          <div><strong>Open:</strong> ${portfolio.openCount ?? 0}</div>
          <div><strong>Closed:</strong> ${portfolio.closedCount ?? 0}</div>
          <div><strong>Realized:</strong> $${fmtNum(portfolio.realizedUsd, 2)}</div>
          <div><strong>Avg realized:</strong> ${fmtPct(portfolio.avgRealizedPct, 2)}</div>
        </div>
      `
        : `<div class="empty">Geen portfolio data.</div>`
    }
  `;
}

function renderData(data) {
  lastData = data;

  renderList("moon-elite-list", data?.funnel?.elite || [], renderCoinCard);
  renderList("moon-almost-list", data?.funnel?.almost || [], renderCoinCard);
  renderList("moon-buildup-list", data?.funnel?.buildup || [], renderCoinCard);
  renderList("moon-radar-list", data?.funnel?.radar || [], renderCoinCard);

  renderPortfolio(data?.portfolio || null, data?.btc || null);

  if (data?.ok === false) {
    setStatus(data.error || "error", "error");
    return;
  }

  const eliteCount = data?.counts?.elite ?? 0;
  const almostCount = data?.counts?.almost ?? 0;
  const buildupCount = data?.counts?.buildup ?? 0;
  const radarCount = data?.counts?.radar ?? 0;

  setStatus(
    `ok • ELITE ${eliteCount} • ALMOST ${almostCount} • BUILDUP ${buildupCount} • RADAR ${radarCount}`,
    "ok"
  );
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
    setStatus("error", "error");

    $("moon-elite-list").innerHTML = `<div class="error-box">Scan fout: ${String(e.message || e)}</div>`;
    $("moon-almost-list").innerHTML = `<div class="empty">Sterk, bijna klaar.</div>`;
    $("moon-buildup-list").innerHTML = `<div class="empty">In opbouw / in beeld.</div>`;
    $("moon-radar-list").innerHTML = `<div class="empty">Brede watchlist.</div>`;
    $("moon-portfolio").innerHTML = `<div class="error-box">Scan fout: ${String(e.message || e)}</div>`;
  }
}

function initMoonPage() {
  $("btn-bull")?.addEventListener("click", () => setMode("bull"));
  $("btn-bear")?.addEventListener("click", () => setMode("bear"));
  $("btn-refresh")?.addEventListener("click", () => fetchMoonData());

  // Publieke site: scan nu niet direct triggeren
  $("btn-scan")?.addEventListener("click", () => {
    alert("Moon scan loopt automatisch elke 15 minuten.");
  });

  fetchMoonData();

  // extra refresh op frontend, los van cron
  setInterval(fetchMoonData, 60000);
}

document.addEventListener("DOMContentLoaded", initMoonPage);