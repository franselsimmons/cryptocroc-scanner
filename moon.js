let mode = "bull";
let lastData = null;
let activeCoin = null;

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

function fmtUsdCompact(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  if (Math.abs(v) >= 1_000_000_000) return `$${(v / 1_000_000_000).toFixed(2)}B`;
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(0)}`;
}

function stageScore(c) {
  const edge = Number(c?.edgeScore);
  if (Number.isFinite(edge)) return Math.max(0, Math.min(100, Math.round(edge)));

  const conf = Number(c?.confidence);
  if (!Number.isFinite(conf)) return 0;
  return conf <= 1 ? Math.round(conf * 100) : Math.round(conf);
}

function setStatus(data) {
  const el = $("moon-status");
  const sub = $("moon-substatus");
  if (!el || !sub) return;

  if (!data || data.ok === false) {
    el.textContent = "Status: error";
    el.className = "hero-status error";
    sub.textContent = "Kan data niet laden.";
    return;
  }

  const counts = data.counts || {};
  el.textContent =
    `Status: ok • ELITE ${counts.elite ?? 0} • ALMOST ${counts.almost ?? 0} • BUILDUP ${counts.buildup ?? 0} • RADAR ${counts.radar ?? 0}`;
  el.className = "hero-status ok";

  const btcState = data?.btc?.state || "-";
  const whaleFlow = data?.whaleFlow ?? 0;
  sub.textContent = `Mode: ${mode.toUpperCase()} • BTC: ${btcState} • Whale flow: ${whaleFlow}`;
}

function emptyHtml(text) {
  return `<div class="empty-box">${text}</div>`;
}

function scoreBar(score) {
  const safe = Math.max(0, Math.min(100, Number(score) || 0));
  return `
    <div class="score-wrap">
      <div class="score-bar">
        <div class="score-fill" style="width:${safe}%"></div>
      </div>
      <div class="score-num">${safe}/100</div>
    </div>
  `;
}

function cardReason(c, section) {
  if (section === "elite") return "Klaar voor directe focus. Hoogste Moon-kwaliteit.";
  if (section === "almost") return "Bijna entry — mist nog 1–2 checks.";
  if (section === "buildup") return "Nog niet instappen, wel klaarzetten.";
  return "Vroege watchlist. Meer ruis, maar kan snel draaien.";
}

function renderCoinCard(c, section) {
  const score = stageScore(c);
  const stage = String(c?.stage || section || "").toUpperCase();

  return `
    <button class="coin-card" type="button" data-symbol="${String(c.symbol || "").replace(/"/g, "&quot;")}">
      <div class="coin-top">
        <div class="coin-head">
          <div class="coin-symbol">${c.symbol || "-"}</div>
          <div class="coin-name">${c.name || ""}</div>
        </div>
        ${scoreBar(score)}
      </div>

      <div class="coin-meta">
        <span>chg24: ${fmtPct(c.change24, 2)}</span>
        <span>vol: ${fmtUsdCompact(c.volume)}</span>
        <span>mc: ${fmtUsdCompact(c.marketCap)}</span>
      </div>

      <div class="coin-meta">
        <span>vm: ${fmtNum(c.vm, 2)}</span>
        <span>price: $${fmtNum(c.price, 8)}</span>
        <span>${mode.toUpperCase()} • ${stage}</span>
      </div>

      <div class="coin-plan">
        <span>SL: $${fmtNum(c?.tradePlan?.sl, 8)}</span>
        <span>TP: $${fmtNum(c?.tradePlan?.tp, 8)}</span>
      </div>

      <div class="coin-reason">${cardReason(c, section)}</div>
    </button>
  `;
}

function renderList(containerId, items, section) {
  const el = $(containerId);
  if (!el) return;

  if (!Array.isArray(items) || items.length === 0) {
    el.innerHTML = emptyHtml("Geen coins.");
    return;
  }

  el.innerHTML = items.map((c) => renderCoinCard(c, section)).join("");
}

function bindCardClicks() {
  document.querySelectorAll(".coin-card").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sym = btn.getAttribute("data-symbol");
      const coin = findCoin(sym);
      if (coin) openModal(coin);
    });
  });
}

function renderData(data) {
  lastData = data;
  setStatus(data);

  renderList("moon-elite-list", data?.funnel?.elite || [], "elite");
  renderList("moon-almost-list", data?.funnel?.almost || [], "almost");
  renderList("moon-buildup-list", data?.funnel?.buildup || [], "buildup");
  renderList("moon-radar-list", data?.funnel?.radar || [], "radar");

  bindCardClicks();
}

function findCoin(symbol) {
  if (!lastData?.funnel || !symbol) return null;
  const all = [
    ...(lastData.funnel.elite || []),
    ...(lastData.funnel.almost || []),
    ...(lastData.funnel.buildup || []),
    ...(lastData.funnel.radar || []),
  ];
  return all.find((x) => String(x.symbol || "").toUpperCase() === String(symbol).toUpperCase()) || null;
}

async function fetchMoonData() {
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
    setStatus({ ok: false });

    $("moon-elite-list").innerHTML = `<div class="empty-box error-box">Scan fout: ${String(e.message || e)}</div>`;
    $("moon-almost-list").innerHTML = emptyHtml("Geen coins.");
    $("moon-buildup-list").innerHTML = emptyHtml("Geen coins.");
    $("moon-radar-list").innerHTML = emptyHtml("Geen coins.");
  }
}

function setMode(nextMode) {
  mode = nextMode === "bear" ? "bear" : "bull";

  $("btn-bull")?.classList.toggle("active", mode === "bull");
  $("btn-bear")?.classList.toggle("active", mode === "bear");

  fetchMoonData();
}

function openModal(coin) {
  activeCoin = coin;

  $("moon-modal-title").textContent =
    `${coin.symbol || "-"} • ${mode.toUpperCase()} • ${String(coin.stage || "-").toUpperCase()}`;
  $("moon-modal-subtitle").textContent =
    `Price $${fmtNum(coin.price, 8)} • Chg24 ${fmtPct(coin.change24, 2)} • VM ${fmtNum(coin.vm, 2)} • Conf ${stageScore(coin)}/100`;

  renderModalTabs(coin, "actie");

  $("moon-modal")?.classList.remove("hidden");
  $("moon-modal")?.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal() {
  activeCoin = null;
  $("moon-modal")?.classList.add("hidden");
  $("moon-modal")?.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
}

function renderModalTabs(coin, activeTab) {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === activeTab);
  });

  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.add("hidden");
  });

  const action = $("moon-tab-actie");
  const why = $("moon-tab-waarom");
  const liq = $("moon-tab-liquidity");
  const det = $("moon-tab-details");

  const tp = Number(coin?.tradePlan?.tp);
  const sl = Number(coin?.tradePlan?.sl);
  const entry = Number(coin?.tradePlan?.entry || coin?.price);
  const rr = Number(coin?.tradePlan?.rr);

  const tpPct = Number.isFinite(entry) && Number.isFinite(tp) && entry > 0
    ? ((tp - entry) / entry) * 100 * (mode === "bear" ? -1 : 1)
    : null;

  const slPct = Number.isFinite(entry) && Number.isFinite(sl) && entry > 0
    ? ((sl - entry) / entry) * 100 * (mode === "bear" ? -1 : 1)
    : null;

  action.innerHTML = `
    <div class="detail-card">
      <h4>Wat moet je doen</h4>
      <div class="action-box">
        <div class="action-title">${
          coin.stage === "ELITE" ? "ENTRY KLAAR" :
          coin.stage === "ALMOST" ? "KLAARZETTEN" :
          coin.stage === "BUILDUP" ? "WATCH / KLAARZETTEN" :
          "WATCHLIST"
        }</div>
        <div class="action-sub">
          ${
            coin.stage === "ELITE" ? "Hoogste Moon-kwaliteit. Directe focus." :
            coin.stage === "ALMOST" ? "Bijna klaar, mist nog 1–2 checks" :
            coin.stage === "BUILDUP" ? "Nog niet instappen, wel klaarzetten" :
            "Vroege fase. Alleen volgen"
          }
        </div>
      </div>

      <div class="kv-table">
        <div class="kv-row"><span>Plan</span><span>${
          coin.stage === "ELITE"
            ? "Focus / mogelijke entry"
            : coin.stage === "ALMOST"
            ? "Nog niet instappen, wel klaarzetten"
            : coin.stage === "BUILDUP"
            ? "Volgen en wachten"
            : "Alleen watchlist"
        }</span></div>

        <div class="kv-row"><span>Entry</span><span>$${fmtNum(entry, 8)}</span></div>
        <div class="kv-row"><span>SL</span><span>$${fmtNum(sl, 8)} ${slPct == null ? "" : `(${fmtPct(slPct, 2)})`}</span></div>
        <div class="kv-row"><span>TP</span><span>$${fmtNum(tp, 8)} ${tpPct == null ? "" : `(${fmtPct(tpPct, 2)})`}</span></div>
        <div class="kv-row"><span>R:R</span><span>${fmtNum(rr, 2)}</span></div>
        <div class="kv-row"><span>Bron SL/TP</span><span>Systeem (exact)</span></div>
      </div>
    </div>
  `;

  why.innerHTML = `
    <div class="detail-card">
      <h4>Waarom staat hij hier</h4>

      <div class="reason-item">
        <div class="reason-title">✓ Stage: ${String(coin.stage || "-").toUpperCase()}</div>
        <div class="reason-sub">score: ${coin.scoreProbability != null ? fmtNum(Number(coin.scoreProbability) * 100, 1) + "/100" : stageScore(coin) + "/100"}</div>
      </div>

      <div class="reason-item">
        <div class="reason-title">✓ Confidence</div>
        <div class="reason-sub">Score: ${stageScore(coin)}/100</div>
      </div>

      <div class="reason-item">
        <div class="reason-title">✓ Pump / Dump kans</div>
        <div class="reason-sub">Pump: ${fmtPct(Number(coin.moonProbability || 0) * 100, 1)} • Dump: ${fmtPct(Number(coin.dumpProbability || 0) * 100, 1)}</div>
      </div>

      <div class="reason-item warn">
        <div class="reason-title">⚠ Waarom nog niet hoger</div>
        <div class="reason-sub">${
          coin.stage === "ELITE"
            ? "Dit is al de hoogste Moon-stage."
            : coin.stage === "ALMOST"
            ? "Mist nog 1–2 checks voor ELITE."
            : coin.stage === "BUILDUP"
            ? "Nog niet genoeg bevestiging voor ALMOST."
            : "Nog te vroeg voor BUILDUP/ALMOST."
        }</div>
      </div>
    </div>
  `;

  liq.innerHTML = `
    <div class="detail-card">
      <h4>Liquidity (Orderbook + Depth)</h4>

      <div class="kv-table">
        <div class="kv-row"><span>Spread</span><span>${fmtPct(coin?.ob?.spreadPct, 3)}</span></div>
        <div class="kv-row"><span>Bid depth</span><span>${fmtUsdCompact(coin?.ob?.depthBidUsd)}</span></div>
        <div class="kv-row"><span>Ask depth</span><span>${fmtUsdCompact(coin?.ob?.depthAskUsd)}</span></div>
        <div class="kv-row"><span>Depth min 1%</span><span>${fmtUsdCompact(coin?.ob?.depthMinUsd1p)}</span></div>
        <div class="kv-row"><span>OB score</span><span>${fmtNum(coin?.ob?.score, 5)}</span></div>
      </div>
    </div>
  `;

  det.innerHTML = `
    <div class="detail-card">
      <h4>Details</h4>

      <div class="kv-table">
        <div class="kv-row"><span>Naam</span><span>${coin.name || "-"}</span></div>
        <div class="kv-row"><span>Symbol</span><span>${coin.symbol || "-"}</span></div>
        <div class="kv-row"><span>Price</span><span>$${fmtNum(coin.price, 8)}</span></div>
        <div class="kv-row"><span>Market cap</span><span>${fmtUsdCompact(coin.marketCap)}</span></div>
        <div class="kv-row"><span>Volume</span><span>${fmtUsdCompact(coin.volume)}</span></div>
        <div class="kv-row"><span>24h</span><span>${fmtPct(coin.change24, 2)}</span></div>
        <div class="kv-row"><span>VM</span><span>${fmtNum(coin.vm, 3)}</span></div>
        <div class="kv-row"><span>Instability</span><span>${fmtNum(coin.instability_score_raw, 8)}</span></div>
      </div>
    </div>
  `;

  $(`moon-tab-${activeTab}`)?.classList.remove("hidden");
}

function initTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!activeCoin) return;
      renderModalTabs(activeCoin, btn.dataset.tab || "actie");
    });
  });
}

function initMoonPage() {
  $("btn-bull")?.addEventListener("click", () => setMode("bull"));
  $("btn-bear")?.addEventListener("click", () => setMode("bear"));
  $("btn-refresh")?.addEventListener("click", () => fetchMoonData());

  $("btn-scan")?.addEventListener("click", () => {
    alert("Moon scan loopt automatisch via cron.");
  });

  $("moon-modal-close")?.addEventListener("click", closeModal);
  document.querySelector('[data-close="1"]')?.addEventListener("click", closeModal);

  initTabs();
  fetchMoonData();
  setInterval(fetchMoonData, 60000);
}

document.addEventListener("DOMContentLoaded", initMoonPage);