function getBestBucketStr(buckets) {
  if (!Array.isArray(buckets) || !buckets.length) return "-";
  const valid = buckets.filter(b => n(b.count, 0) >= 3);
  if (!valid.length) return "-";
  const best = valid.sort((a, b) => n(b.avgPnlPct, 0) - n(a.avgPnlPct, 0))[0];
  return `${esc(best.key)} (${fmtPct(best.avgPnlPct)})`;
}

function buildTopPriorities(data) {
  const overview = data?.overview || {};
  const groups = data?.groups || {};
  const order = ["trade_funnel", "moon_bull", "moon_bear", "main_bull", "main_bear"];

  const titleMap = {
    trade_funnel: "Trade Funnel Totaal",
    moon_bull: "Moon Bull",
    moon_bear: "Moon Bear",
    main_bull: "Main Bull",
    main_bear: "Main Bear",
  };

  return `
    <section class="panel top-priorities-section">
      <h2>🚀 Actiecentrum: Aanpassingen & Beste Filters</h2>
      <div class="priority-grid">
        ${order
          .map((key) => {
            const item = overview?.[key];
            const group = groups?.[key];
            if (!item || !group) return "";

            const adj = item.topAdjustment || {};
            const tone = adjustmentTone(item.score);
            const buckets = group.buckets || {};

            return `
              <div class="priority-card ${tone}">
                <div class="priority-head">
                  <div class="priority-name">${esc(titleMap[key] || key)}</div>
                  <div class="priority-score">Score ${n(item.score, 0).toFixed(2)}</div>
                </div>

                <div class="priority-action">${esc(adj.title || "Geen harde actie vereist")}</div>
                <div class="priority-text">${esc(adj.shortText || "Monitor de huidige waarden, er is nog geen duidelijke richting.")}</div>
                
                <div class="best-filters-grid">
                  <div class="best-filter-item">
                    <span class="best-filter-label">Beste Entry Q.</span>
                    <span class="best-filter-value">${getBestBucketStr(buckets.byEntryQuality)}</span>
                  </div>
                  <div class="best-filter-item">
                    <span class="best-filter-label">Beste Spread</span>
                    <span class="best-filter-value">${getBestBucketStr(buckets.bySpread)}</span>
                  </div>
                  <div class="best-filter-item">
                    <span class="best-filter-label">Beste OB Score</span>
                    <span class="best-filter-value">${getBestBucketStr(buckets.byObScore)}</span>
                  </div>
                  <div class="best-filter-item">
                    <span class="best-filter-label">Beste Persist.</span>
                    <span class="best-filter-value">${getBestBucketStr(buckets.byPersistence)}</span>
                  </div>
                </div>

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
