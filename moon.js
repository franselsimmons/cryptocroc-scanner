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

function setMeta(data) {
  const el = $("moon-meta");
  if (!el) return;

  const btcState = data?.btc?.state || "-";
  const whaleFlow = data?.whaleFlow ?? "-";

  el.textContent = `Mode: ${mode.toUpperCase()} • BTC: ${btcState} • Whale flow: ${whaleFlow}`;
}

function setMode(nextMode) {
  mode = nextMode === "bear" ? "bear" : "bull";

  $("btn-bull")?.classList.toggle("active", mode === "bull");
  $("btn-bear")?.classList.toggle("active", mode === "bear");

  fetchMoonData();
}

function renderList(containerId, items) {
  const el = $(containerId);
  if (!el) return;

  if (!Array.isArray(items) || items.length === 0) {
    el.innerHTML = `<div class="empty">Geen coins.</div>`;
    return;
  }

  el.innerHTML = items.map(renderCoinCard).join("");
}

function renderCoinCard(c) {
  const bullProb = Number(c?.moonProbability || 0);
  const bearProb = Number(c?.dumpProbability || 0);

  return `
    <div class="coin">
      <div class="coin-top">
        <div class="coin-left">
          <div class="sym">${c.symbol || "-"}</div>
          <div class="name">${c.name || "-"}</div>
        </div>
        <div class="price">$${fmtNum(c.price, 8)}</div>
      </div>

      <div class="prob">
        <span class="badge stage">${c.stage || "-"}</span>
        <span class="badge bull">Pump ${fmtPct(bullProb * 100, 1)}</span>
        <span class="badge bear">Dump ${fmtPct(bearProb * 100, 1)}</span>
      </div>

      <div class="meta">
        <span><strong>24h:</strong> ${fmtPct(c.change24, 2)}</span>
        <span><strong>VM:</strong> ${fmtNum(c.vm, 3)}</span>
        <span><strong>Conf:</strong> ${fmtNum((Number(c.confidence || 0) * 100), 1)}</span>
        <span><strong>Edge:</strong> ${fmtNum(c.edgeScore, 1)}</span>
        <span><strong>Spread:</strong> ${fmtPct(c?.ob?.spreadPct, 3)}</span>
        <span><strong>OB score:</strong> ${fmtNum(c?.ob?.score, 5)}</span>
        <span><strong>Depth:</strong> $${fmtNum(c?.ob?.depthMinUsd1p, 0)}</span>
        <span><strong>Instability:</strong> ${fmtNum(c?.instability_score_raw, 6)}</span>
        <span><strong>Entry:</strong> ${fmtNum(c?.tradePlan?.entry, 8)}</span>
        <span><strong>SL:</strong> ${fmtNum(c?.tradePlan?.sl, 8)}</span>
        <span><strong>TP:</strong> ${fmtNum(c?.tradePlan?.tp, 8)}</span>
        <span><strong>RR:</strong> ${fmtNum(c?.tradePlan?.rr, 2)}</span>
      </div>
    </div>
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
    <div class="portfolio-grid">
      <div class="portfolio-block">
        <div><strong>BTC state:</strong> ${btc?.state || "-"}</div>
        <div><strong>BTC 24h:</strong> ${fmtPct(btc?.chg24, 2)}</div>
        <div><strong>BTC range:</strong> ${fmtPct(btc?.range24, 2)}</div>
        <div><strong>Whale flow:</strong> ${whaleFlow ?? "-"}</div>
      </div>

      ${
        portfolio
          ? `
            <div class="portfolio-block">
              <div><strong>Mode:</strong> ${(portfolio.mode || mode).toUpperCase()}</div>
              <div><strong>Open:</strong> ${portfolio.openCount ?? 0}</div>
              <div><strong>Closed:</strong> ${portfolio.closedCount ?? 0}</div>
              <div><strong>Position size:</strong> $${fmtNum(portfolio.posUsd, 2)}</div>
              <div><strong>Realized:</strong> $${fmtNum(portfolio.realizedUsd, 2)}</div>
              <div><strong>Avg realized:</strong> ${fmtPct(portfolio.avgRealizedPct, 2)}</div>
            </div>
          `
          : `<div class="portfolio-block"><div>Geen portfolio data.</div></div>`
      }
    </div>
  `;
}

function renderData(data) {
  lastData = data;

  renderList("moon-elite-list", data?.funnel?.elite || []);
  renderList("moon-almost-list", data?.funnel?.almost || []);
  renderList("moon-buildup-list", data?.funnel?.buildup || []);
  renderList("moon-radar-list", data?.funnel?.radar || []);

  renderPortfolio(data?.portfolio || null, data?.btc || null, data?.whaleFlow ?? null);
  setMeta(data);

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
    $("moon-almost-list").innerHTML = `<div class="empty">Sterke kandidaten verschijnen hier.</div>`;
    $("moon-buildup-list").innerHTML = `<div class="empty">Buildup coins verschijnen hier.</div>`;
    $("moon-radar-list").innerHTML = `<div class="empty">Radar coins verschijnen hier.</div>`;
    $("moon-portfolio").innerHTML = `<div class="error-box">Scan fout: ${String(e.message || e)}</div>`;
  }
}

function initMoonPage() {
  $("btn-bull")?.addEventListener("click", () => setMode("bull"));
  $("btn-bear")?.addEventListener("click", () => setMode("bear"));
  $("btn-refresh")?.addEventListener("click", () => fetchMoonData());

  $("btn-scan")?.addEventListener("click", () => {
    alert("Moon scan loopt automatisch via cron. Gebruik de protected scan endpoint alleen intern.");
  });

  fetchMoonData();
  setInterval(fetchMoonData, 60000);
}

document.addEventListener("DOMContentLoaded", initMoonPage);