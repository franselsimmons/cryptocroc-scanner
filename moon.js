(() => {
  const state = {
    mode: "bull",
    loading: false,
    data: null,
    error: null,
  };

  const el = {
    statusText: document.getElementById("statusText"),
    eliteList: document.getElementById("eliteList"),
    almostList: document.getElementById("almostList"),
    buildupList: document.getElementById("buildupList"),
    radarList: document.getElementById("radarList"),
    metaBox: document.getElementById("metaBox"),
    btnBull: document.getElementById("btnBull"),
    btnBear: document.getElementById("btnBear"),
    btnRefresh: document.getElementById("btnRefresh"),
    btnScan: document.getElementById("btnScan"),
  };

  const STORAGE_SCAN_TOKEN = "moon_scan_token";

  function fmtNum(v, digits = 2) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
  }

  function fmtPrice(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "n/a";
    return n >= 1 ? n.toFixed(4) : n.toFixed(8);
  }

  function setMode(mode) {
    state.mode = mode === "bear" ? "bear" : "bull";
    el.btnBull.classList.toggle("active", state.mode === "bull");
    el.btnBear.classList.toggle("active", state.mode === "bear");
    fetchMoonData();
  }

  function renderEmpty(container, text = "Geen items") {
    container.innerHTML = `<div class="empty">${text}</div>`;
  }

  function renderList(container, items) {
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return renderEmpty(container);

    container.innerHTML = arr.map((coin) => {
      const trade = coin?.trade || null;
      const ob = coin?.ob || {};
      const why = coin?.why || {};

      const tradeLine = trade
        ? `trade: ${trade.status || "?"} | entry ${fmtPrice(trade.entryPrice)} | pnl ${fmtNum(trade.pnlPct, 2)}%`
        : "trade: geen";

      const extra = [
        `price ${fmtPrice(coin?.price)} | conf ${fmtNum(coin?.confidence, 0)} | vm ${fmtNum(coin?.vm, 3)} | 24h ${fmtNum(coin?.change24, 2)}%`,
        `OB score ${fmtNum(ob?.score, 4)} | spread ${fmtNum(ob?.spreadPct, 3)}% | depth ${fmtNum(coin?.depthUsd, 0)} / floor ${fmtNum(coin?.floorUsd, 0)}`,
        tradeLine,
        `why: ${why?.elite || why?.almost || why?.buildup || "n/a"} | ${why?.eliteExtra || why?.cooldown || ""}`.trim(),
      ].join("\n");

      return `
        <div class="item">
          <div class="item-top">
            <div class="item-title">${coin?.symbol || "?"} ${coin?.name ? `— ${coin.name}` : ""}</div>
            <div class="item-stage">${coin?.stage || ""}${coin?.tier ? ` | tier ${coin.tier}` : ""}</div>
          </div>
          <div class="item-meta">${extra}</div>
        </div>
      `;
    }).join("");
  }

  function renderMeta(data) {
    const btc = data?.btc || null;
    const portfolio = data?.portfolio || null;
    const counts = data?.counts || {};

    el.metaBox.innerHTML = `
      <div>mode: <b>${state.mode === "bull" ? "LONG / BULL" : "SHORT / BEAR"}</b></div>
      <div>BTC: <b>${btc?.state || "n/a"}</b> | 24h: <b>${fmtNum(btc?.chg24, 3)}%</b> | range24: <b>${fmtNum(btc?.range24, 3)}%</b></div>
      <div>counts: elite <b>${counts.elite ?? 0}</b>, almost <b>${counts.almost ?? 0}</b>, buildup <b>${counts.buildup ?? 0}</b>, radar <b>${counts.radar ?? 0}</b></div>
      <div>portfolio: open <b>${portfolio?.openCount ?? 0}</b>, closed <b>${portfolio?.closedCount ?? 0}</b>, realized <b>${fmtNum(portfolio?.realizedUsd, 2)} USD</b>, avg <b>${fmtNum(portfolio?.avgRealizedPct, 2)}%</b></div>
      <div>updated: <b>${data?.ts ? new Date(data.ts).toLocaleString() : "n/a"}</b></div>
      ${data?.note ? `<div>${data.note}</div>` : ""}
    `;
  }

  function renderError(message) {
    el.statusText.textContent = "Status: error";
    el.statusText.classList.add("err");

    const box = `<div class="empty err">${message}</div>`;
    el.eliteList.innerHTML = box;
    el.almostList.innerHTML = `<div class="empty"></div>`;
    el.buildupList.innerHTML = `<div class="empty"></div>`;
    el.radarList.innerHTML = `<div class="empty"></div>`;
    el.metaBox.innerHTML = `<div class="err">${message}</div>`;
  }

  async function fetchMoonData() {
    state.loading = true;
    state.error = null;
    el.statusText.classList.remove("err");
    el.statusText.textContent = "Status: laden...";

    try {
      const url = `/api/moon/public-latest?mode=${state.mode}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
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

      state.data = json;

      el.statusText.textContent = "Status: live";
      renderList(el.eliteList, json?.funnel?.elite || []);
      renderList(el.almostList, json?.funnel?.almost || []);
      renderList(el.buildupList, json?.funnel?.buildup || []);
      renderList(el.radarList, json?.funnel?.radar || []);
      renderMeta(json);
    } catch (err) {
      state.error = err?.message || String(err);
      renderError(state.error);
    } finally {
      state.loading = false;
    }
  }

  function askScanToken() {
    const existing = sessionStorage.getItem(STORAGE_SCAN_TOKEN) || "";
    const token = window.prompt(
      "Voer de actuele CRON_SECRET in om handmatig een scan te starten:",
      existing
    );

    if (!token) return null;

    const clean = token.trim();
    if (!clean) return null;

    sessionStorage.setItem(STORAGE_SCAN_TOKEN, clean);
    return clean;
  }

  async function runScanNow() {
    const token = askScanToken();
    if (!token) return;

    el.statusText.textContent = "Status: scan gestart...";
    el.statusText.classList.remove("err");

    try {
      const res = await fetch(`/api/moon/run-all?token=${encodeURIComponent(token)}`, {
        method: "GET",
        headers: { accept: "application/json" },
      });

      const text = await res.text();

      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`Ongeldige JSON van scan-endpoint: ${text.slice(0, 200)}`);
      }

      if (res.status === 401) {
        sessionStorage.removeItem(STORAGE_SCAN_TOKEN);
        throw new Error("Unauthorized — gebruik de nieuwe CRON_SECRET uit Vercel.");
      }

      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${res.status}`);
      }

      await fetchMoonData();
    } catch (e) {
      renderError(`Scan fout: ${String(e?.message || e)}`);
    }
  }

  el.btnBull.addEventListener("click", () => setMode("bull"));
  el.btnBear.addEventListener("click", () => setMode("bear"));
  el.btnRefresh.addEventListener("click", fetchMoonData);
  el.btnScan.addEventListener("click", runScanNow);

  fetchMoonData();
})();