// /api/analyze-main.js
// Vereist: KV keys "latest:bull" en "latest:bear" (of via keyMainLatest) + event streams:
// scan_radar, scan_buildup, scan_almost, scan_transition, scan_reject
import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";

// Helper voor main latest key (fallback)
function keyMainLatest(mode) {
  return `latest:${String(mode || "bull").toLowerCase()}`;
}

export const config = RUNTIME_CONFIG;

// ===================== HELPERS =====================
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function safeArr(x) { return Array.isArray(x) ? x : []; }
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function inc(map, key) { const k = String(key || "unknown"); map[k] = (map[k] || 0) + 1; }
function topN(map, k = 12) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function fmtDate(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "n/a";
  return d.toLocaleString("nl-NL", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ===================== ROBUSTE FLATTEN =====================
function safeStage(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "object") return Object.values(x);
  return [];
}

function flattenMainCoins(latest) {
  const f = latest?.funnel || {};

  return [
    ...safeStage(f.radar).map(c => ({ ...c, _system: "main", _stage: c?.stage || "RADAR" })),
    ...safeStage(f.buildup).map(c => ({ ...c, _system: "main", _stage: c?.stage || "BUILDUP" })),
    ...safeStage(f.almost).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ALMOST" })),
    ...safeStage(f.entry).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ENTRY" })),
    ...safeStage(f.elite_ignition).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ELITE_IGNITION" })),
    ...safeStage(f.elite_expansion).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ELITE_EXPANSION" })),
    ...safeStage(f.elite_cascade).map(c => ({ ...c, _system: "main", _stage: c?.stage || "ELITE_CASCADE" })),
    ...safeStage(f.hold).map(c => ({ ...c, _system: "main", _stage: c?.stage || "HOLD" })),
  ];
}

function summarizeMainSnapshot(latest) {
  const coins = flattenMainCoins(latest || {});
  const stageCounts = { RADAR: 0, BUILDUP: 0, ALMOST: 0, ENTRY: 0, ELITE_IGNITION: 0, ELITE_EXPANSION: 0, ELITE_CASCADE: 0, HOLD: 0 };
  for (const c of coins) {
    const realStage = String(c?.stage || c?._stage || "RADAR").toUpperCase();
    if (stageCounts[realStage] !== undefined) stageCounts[realStage]++;
    else if (stageCounts[c?._stage] !== undefined) stageCounts[c._stage]++;
  }
  return { ts: latest?.ts || latest?.scannedAt || null, btc: latest?.btc || null, regime: latest?.regime || null, stageCounts };
}

function analyzeMainBottlenecks(coins) {
  const executionReasons = {};
  const checklistFails = {};
  const tradeDeskStatusCounts = {};
  const watchReasons = {};
  for (const c of coins) {
    const ex = c?.execution || {};
    const checklist = Array.isArray(ex.checklist) ? ex.checklist : [];
    inc(tradeDeskStatusCounts, c?.tradeDeskStatus || "UNKNOWN");
    if (ex.reason) inc(executionReasons, ex.reason);
    for (const item of checklist) {
      let name = String(item?.name || "unknown").toLowerCase().replace(/\s+/g, "_");
      if (item?.ok === false) inc(checklistFails, name);
    }
    if (c?.tradeDeskStatus === "WATCH" && ex?.reason) inc(watchReasons, ex.reason);
  }
  return { topChecklistFails: topN(checklistFails, 10), topExecutionFails: topN(executionReasons, 10), tradeDeskStatusCounts: topN(tradeDeskStatusCounts, 10), watchReasons: topN(watchReasons, 10) };
}

function summarizeRejects(events, sinceMs, mode) {
  const rejects = safeArr(events).filter(e => e?.type === "scan_reject" && n(e?.ts,0) >= sinceMs && (!mode || e?.mode === mode));
  const byStage = { RADAR: {}, BUILDUP: {}, ALMOST: {}, ENTRY: {} };
  const byCode = {};
  for (const e of rejects) {
    const stage = String(e?.stageTried || "").toUpperCase();
    const code = String(e?.rejectCode || "UNKNOWN");
    if (byStage[stage]) inc(byStage[stage], code);
    inc(byCode, code);
  }
  return { totalRejects: rejects.length, byStage: Object.fromEntries(Object.entries(byStage).map(([k,v]) => [k, topN(v,15)])), byCode: topN(byCode,20) };
}

function renderCounters(title, counters) {
  const items = topN(counters || {}, 14).map(x => `<li><b>${esc(x.key)}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";
  return `<div class="box"><h4>${esc(title)}</h4><ul>${items}</ul></div>`;
}

function coinRow(c) {
  const ob = c?.ob || {};
  const ex = c?.execution || {};
  const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>`;
  return `
    <tr class="coin-row" data-symbol="${esc(c?.symbol || "")}" data-name="${esc(c?.name || "")}">
       <td><b>${esc(c?.symbol || "?")}</b><div class="muted">${esc(c?.name || "")}</div></td>
       <td>${esc(c?.stage || c?._stage || "-")}</td>
       <td>${n(c?.entryQuality,0)}</td>
       <td>${n(c?.persistenceScore,0)}</td>
       <td>${esc(c?.tradeDeskStatus || "-")}</td>
       <td>${esc(ex?.reason || "-")}</td>
       <td>${kv("spread", ob.spreadPct != null ? n(ob.spreadPct,0).toFixed(3) : "-")}</td>
       <td>${kv("depth", ob.depthMinUsd1p != null ? n(ob.depthMinUsd1p,0) : "-")}</td>
       <td>${kv("score", ob.score != null ? n(ob.score,0).toFixed(5) : "-")}</td>
     </tr>
  `;
}

function stageTable(title, arr) {
  return `
    <div class="stage">
      <h3>${esc(title)} (${arr.length})</h3>
      <div style="overflow-x:auto"><table>
        <thead><tr><th>Coin</th><th>Stage</th><th>EntryQ</th><th>Persist</th><th>Status</th><th>Exec reason</th><th>Spread</th><th>Depth</th><th>OB score</th></tr></thead>
        <tbody>${arr.map(coinRow).join("") || `<tr><td colspan="9">n/a</td></tr>`}</tbody>
      </table></div>
    </div>
  `;
}

function modeCard(mode, latest, sessionStartMs, events) {
  const coins = flattenMainCoins(latest || {});
  const byStage = {
    RADAR: coins.filter(x => x._stage === "RADAR"),
    BUILDUP: coins.filter(x => x._stage === "BUILDUP"),
    ALMOST: coins.filter(x => x._stage === "ALMOST"),
    ENTRY: coins.filter(x => x._stage === "ENTRY"),
    ELITE: coins.filter(x => x._stage === "ELITE_IGNITION" || x._stage === "ELITE_EXPANSION" || x._stage === "ELITE_CASCADE"),
  };
  const snapshot = summarizeMainSnapshot(latest);
  const bottlenecks = analyzeMainBottlenecks(coins);
  const rejectSum = summarizeRejects(events, sessionStartMs, mode);

  return `
    <div class="card">
      <h2>${esc(mode.toUpperCase())}</h2>
      <div class="muted">Latest: ${snapshot.ts ? fmtDate(snapshot.ts) : "n/a"} — BTC: ${esc(snapshot.btc?.state || "-")}</div>
      <div class="stats">
        <span class="pill">RADAR: ${snapshot.stageCounts.RADAR}</span>
        <span class="pill">BUILDUP: ${snapshot.stageCounts.BUILDUP}</span>
        <span class="pill">ALMOST: ${snapshot.stageCounts.ALMOST}</span>
        <span class="pill">ENTRY: ${snapshot.stageCounts.ENTRY}</span>
        <span class="pill">ELITE: ${(snapshot.stageCounts.ELITE_IGNITION||0)+(snapshot.stageCounts.ELITE_EXPANSION||0)+(snapshot.stageCounts.ELITE_CASCADE||0)}</span>
      </div>
      <div class="grid">
        <div class="box"><h4>Rejects (sinds sessie)</h4><div>Totaal: ${rejectSum.totalRejects}</div><h5>Per code</h5><ul>${rejectSum.byCode.map(x => `<li><b>${esc(x.key)}</b> — ${x.count}</li>`).join("")}</ul></div>
        <div class="box"><h4>Per stage</h4>${Object.entries(rejectSum.byStage).map(([k,v]) => `<div><b>${k}</b><ul>${v.map(x => `<li>${esc(x.key)} — ${x.count}</li>`).join("")}</ul></div>`).join("")}</div>
      </div>
      <div class="grid">
        ${renderCounters("Top checklist fails", Object.fromEntries(bottlenecks.topChecklistFails.map(x => [x.key, x.count])))}
        ${renderCounters("Top exec reasons", Object.fromEntries(bottlenecks.topExecutionFails.map(x => [x.key, x.count])))}
        ${renderCounters("TradeDesk status", Object.fromEntries(bottlenecks.tradeDeskStatusCounts.map(x => [x.key, x.count])))}
      </div>
      ${stageTable("RADAR", byStage.RADAR)}
      ${stageTable("BUILDUP", byStage.BUILDUP)}
      ${stageTable("ALMOST", byStage.ALMOST)}
      ${stageTable("ENTRY", byStage.ENTRY)}
      ${stageTable("ELITE", byStage.ELITE)}
    </div>
  `;
}

function htmlPage({ bullLatest, bearLatest, events, sessionStartMs }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Main Analyse</title>
<style>
  body{font-family:ui-sans-serif;background:#0b0f14;color:#e6edf3;margin:0;padding:20px}
  .wrap{max-width:1400px;margin:0 auto}
  .card{background:#111826;border:1px solid #1f2a3a;border-radius:14px;padding:16px;margin-bottom:20px}
  h1{margin:0 0 10px}
  .stats{display:flex;gap:16px;flex-wrap:wrap;margin:10px 0}
  .pill{background:#0c1320;border:1px solid #2a3a52;padding:6px 12px;border-radius:20px}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
  .box{background:#0c1320;border:1px solid #1f2a3a;border-radius:12px;padding:10px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:8px;border-bottom:1px solid #1f2a3a;text-align:left;vertical-align:top}
  .muted{color:#9fb0c3}
  .kv{display:flex;justify-content:space-between;border-bottom:1px dashed #233248;padding:2px 0}
  .btn{cursor:pointer;border:1px solid #2a3a52;background:#0c1320;color:#e6edf3;border-radius:12px;padding:10px 12px}
  .search-box{display:flex;gap:8px;margin:12px 0}
  .search-box input{flex:1;padding:8px;border-radius:8px;border:1px solid #2a3a52;background:#0c1320;color:#e6edf3}
  .hidden{display:none}
</style>
</head>
<body>
<div class="wrap">
  <div style="display:flex;justify-content:space-between">
    <h1>Main Analyze — per stage + reject counters</h1>
    <button class="btn" id="resetBtn">Reset Analysis</button>
  </div>
  <div class="search-box"><input type="text" id="coinSearch" placeholder="Zoek symbool of naam"><button class="btn" id="clearSearch">Wis</button></div>
  <div class="grid">${modeCard("bull", bullLatest, sessionStartMs, events)}${modeCard("bear", bearLatest, sessionStartMs, events)}</div>
  <div class="muted" style="margin-top:10px">Session start: ${fmtDate(sessionStartMs)}</div>
</div>
<script>
  const search = document.getElementById("coinSearch");
  const clear = document.getElementById("clearSearch");
  function filter() {
    const term = search.value.trim().toUpperCase();
    document.querySelectorAll(".coin-row").forEach(row => {
      const sym = row.getAttribute("data-symbol")?.toUpperCase() || "";
      const name = row.getAttribute("data-name")?.toUpperCase() || "";
      row.classList.toggle("hidden", term && !sym.includes(term) && !name.includes(term));
    });
  }
  search.addEventListener("input", filter);
  clear.addEventListener("click", () => { search.value = ""; filter(); });
  document.getElementById("resetBtn").addEventListener("click", async () => {
    const secret = new URL(location.href).searchParams.get("secret") || "";
    const res = await fetch("/api/analyze-reset" + (secret ? "?secret="+encodeURIComponent(secret) : ""), { method: "POST" });
    const j = await res.json();
    if(j.ok) location.reload();
    else alert("Reset failed");
  });
</script>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const [bullLatest, bearLatest, radar, buildup, almost, transition, reject, sessionStartMs] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      readEvents("scan_radar", 3000),
      readEvents("scan_buildup", 3000),
      readEvents("scan_almost", 3000),
      readEvents("scan_transition", 8000),
      readEvents("scan_reject", 8000),
      kv.get("analyze:sessionStartMs"),
    ]);

    const events = [
      ...safeArr(radar),
      ...safeArr(buildup),
      ...safeArr(almost),
      ...safeArr(transition),
      ...safeArr(reject),
    ];
    const sess = n(sessionStartMs, 0) || (Date.now() - 7 * 24 * 60 * 60 * 1000);

    if (String(req.query?.format || "").toLowerCase() === "json") {
      res.status(200).json({
        ok: true,
        ts: Date.now(),
        sessionStartMs: sess,
        latest: { bull: bullLatest, bear: bearLatest },
        derived: {
          bull: {
            snapshot: summarizeMainSnapshot(bullLatest),
            bottlenecks: analyzeMainBottlenecks(flattenMainCoins(bullLatest)),
            rejects: summarizeRejects(events, sess, "bull"),
          },
          bear: {
            snapshot: summarizeMainSnapshot(bearLatest),
            bottlenecks: analyzeMainBottlenecks(flattenMainCoins(bearLatest)),
            rejects: summarizeRejects(events, sess, "bear"),
          },
        },
      });
      return;
    }

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.status(200).end(htmlPage({ bullLatest, bearLatest, events, sessionStartMs: sess }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: String(err.message) });
  }
}