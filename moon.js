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

function renderList(containerId, items, renderer, emptyText) {
  const el = $(containerId);
  if (!el) return;

  if (!Array.isArray(items) || items.length === 0) {
    el.innerHTML = `<div class="empty">${emptyText}</div>`;
    return;
  }

  el.innerHTML = `<div class="coin-list">${items.map(renderer).join("")}</div>`;
}

function renderCoinCard(c) {
  const prob = mode === "bear"
    ? Number(c.dumpProbability || 0)
    : Number(c.moonProbability || 0);

  return `
    <div class="coin">
      <div class="sym">${c.symbol || "-"}</div>
      <div class="meta">
        $${fmtNum(c.price, 8)}<br>
        24h: ${fmtPct(c.change24, 2)} · 1h: ${fmtPct(c.change1h, 2)}<br>
        VM: ${fmtNum(c.vm, 3)} · Conf: ${fmtNum(c.confidence, 3)}<br>
        ${mode === "bear" ? "Dump" : "Moon"}: ${fmtNum(prob, 3)}
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
    <div class="coin-list">
      <div class="coin">
        <div class="sym">BTC regime</div>
        <div class="meta">
          State: ${btc?.state || "-"}<br>
          24h: ${fmtPct(btc?.chg24, 2)}
        </div>
      </div>
      ${
        portfolio
          ? `
          <div class="coin">
            <div class="sym">Portfolio</div>
            <div class="meta">
              Open: ${portfolio.openCount ?? 0}<br>
              Closed: ${portfolio.closedCount ?? 0}<br>
              Realized: $${fmtNum(portfolio.realizedUsd, 2)}<br>
              Avg realized: ${fmtPct(portfolio.avgRealizedPct, 2)}
            </div>
          </div>
        `
          : `<div class="empty">Geen portfolio data.</div>`
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
    `Geen ${mode} ELITE coins.`
  );
  renderList(
    "moon-almost-list",
    data?.funnel?.almost || [],
    renderCoinCard,
    `Geen ${mode} ALMOST coins.`
  );
  renderList(
    "moon-buildup-list",
    data?.funnel?.buildup || [],
    renderCoinCard,
    `Geen ${mode} BUILDUP coins.`
  );
  renderList(
    "moon-radar-list",
    data?.funnel?.radar || [],
    renderCoinCard,
    `Geen ${mode} RADAR coins.`
  );

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
    `ok • ${mode.toUpperCase()} • ELITE ${eliteCount} • ALMOST ${almostCount} • BUILDUP ${buildupCount} • RADAR ${radarCount}`,
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

    $("moon-elite-list").innerHTML = `<div class="empty">Scan fout: ${String(e.message || e)}</div>`;
    $("moon-almost-list").innerHTML = `<div class="empty">Sterk, bijna klaar.</div>`;
    $("moon-buildup-list").innerHTML = `<div class="empty">In opbouw / in beeld.</div>`;
    $("moon-radar-list").innerHTML = `<div class="empty">Brede watchlist.</div>`;
    $("moon-portfolio").innerHTML = `<div class="empty">Scan fout: ${String(e.message || e)}</div>`;
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