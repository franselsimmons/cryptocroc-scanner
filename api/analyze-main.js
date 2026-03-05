// /api/analyze-main.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";
import { readEvents } from "../lib/_analytics.js";

export const config = RUNTIME_CONFIG;

function safeArr(x) { return Array.isArray(x) ? x : []; }
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function fmtDate(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "n/a";
  return d.toLocaleString("nl-NL", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function topN(map, k = 12) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function inc(map, key) {
  const k = String(key || "Unknown");
  map[k] = (map[k] || 0) + 1;
  return map;
}

function flattenCoins(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeArr(f.radar).map((c) => ({ ...c, _bucket: "RADAR" })),
    ...safeArr(f.buildup).map((c) => ({ ...c, _bucket: "BUILDUP" })),
    ...safeArr(f.almost).map((c) => ({ ...c, _bucket: "ALMOST" })),
    ...safeArr(f.entry).map((c) => ({ ...c, _bucket: "ENTRY" })),
  ];
}

function summarizeFlow(events, sinceMs) {
  const changes = safeArr(events)
    .filter((e) => e?.type === "stage_change")
    .filter((e) => n(e?.ts, 0) >= sinceMs);

  const flow = {};
  const reasonsTo = { RADAR: {}, BUILDUP: {}, ALMOST: {}, ENTRY: {} };

  for (const e of changes) {
    const from = String(e?.from || "").toUpperCase();
    const to = String(e?.to || "").toUpperCase();
    const r = String(e?.reason || "unknown");

    if (from && to) inc(flow, `${from}→${to}`);
    if (to && reasonsTo[to]) inc(reasonsTo[to], r);
  }

  return {
    sinceMs,
    changesCount: changes.length,
    flowTop: topN(flow, 12),
    topReasonsTo: {
      RADAR: topN(reasonsTo.RADAR, 10),
      BUILDUP: topN(reasonsTo.BUILDUP, 10),
      ALMOST: topN(reasonsTo.ALMOST, 10),
      ENTRY: topN(reasonsTo.ENTRY, 10),
    },
  };
}

function summarizeSnapshot(latest) {
  const coins = flattenCoins(latest || {});
  const stageCounts = { RADAR: 0, BUILDUP: 0, ALMOST: 0, ENTRY: 0 };

  // Gate blockers from snapshot (strings in c.gates)
  const gateReasons = { radar: {}, almost: {}, entry: {} };

  for (const c of coins) {
    const st = String(c?._bucket || "RADAR");
    if (stageCounts[st] != null) stageCounts[st]++;

    const g = c?.gates || {};
    if (g.radar) inc(gateReasons.radar, String(g.radar));
    if (g.almost && String(g.almost) !== "n/a") inc(gateReasons.almost, String(g.almost));
    if (g.entry && String(g.entry) !== "n/a") inc(gateReasons.entry, String(g.entry));
  }

  return {
    ts: latest?.ts || null,
    btc: latest?.btc || null,
    stageCounts,
    gateTop: {
      radar: topN(gateReasons.radar, 10),
      almost: topN(gateReasons.almost, 12),
      entry: topN(gateReasons.entry, 12),
    },
    // Diagnostics (als scan dit meegeeft)
    diagnostics: latest?.meta?.diagnostics || null,
  };
}

function renderCounters(title, counters) {
  const items = topN(counters || {}, 14)
    .map((x) => `<li><b>${esc(x.key)}</b> — ${x.count}</li>`)
    .join("") || `<li class="muted">n/a</li>`;

  return `
    <div class="box">
      <h4>${esc(title)}</h4>
      <ul>${items}</ul>
    </div>
  `;
}

function coinRow(c) {
  const ob = c?.ob || {};
  const thr = c?.thr || {};
  const dyn = c?.dyn || {};
  const gates = c?.gates || {};
  const cons = c?.consistency || {};
  const an = c?.anomaly || null;

  const kv = (k, v) => `
    <div class="kv"><span>${esc(k)}</span><b>${esc(v)}</b></div>
  `;

  return `
    <tr>
      <td>
        <b>${esc(c?.symbol || "?")}</b>
        <div class="muted">${esc(c?.name || "")}</div>
      </td>
      <td>${esc(c?.stage || c?._bucket || "-")}</td>
      <td>${n(c?.confidence, 0)}</td>
      <td>${n(c?.vm, 0).toFixed(3)}</td>
      <td>
        ${kv("spreadPct", ob.spreadPct != null ? n(ob.spreadPct, 0).toFixed(3) : "-")}
        ${kv("depthMinUsd1p", ob.depthMinUsd1p != null ? n(ob.depthMinUsd1p, 0).toFixed(0) : "-")}
        ${kv("score", ob.score != null ? n(ob.score, 0).toFixed(5) : "-")}
        ${kv("pressureDeltaUsd", ob.pressureDeltaUsd != null ? n(ob.pressureDeltaUsd, 0).toFixed(0) : "-")}
        ${kv("fresh", ob.fresh === true ? "true" : ob.fresh === false ? "false" : "-")}
        ${kv("valid", ob.valid === true ? "true" : ob.valid === false ? "false" : "-")}
        ${kv("ageSec", ob.ageSec != null ? n(ob.ageSec, 0).toFixed(0) : "-")}
        ${kv("reason", ob.reason || "-")}
      </td>
      <td>
        ${kv("minConfidence", thr.minConfidence != null ? n(thr.minConfidence, 0) : "-")}
        ${kv("spreadMaxPct", thr.spreadMaxPct != null ? n(thr.spreadMaxPct, 0).toFixed(3) : "-")}
        ${kv("depthMinUsd1p", thr.depthMinUsd1p != null ? n(thr.depthMinUsd1p, 0) : "-")}
        ${kv("obScoreMin", thr.obScoreMin != null ? n(thr.obScoreMin, 0).toFixed(5) : "-")}
        ${kv("liqScore", thr.liqScore != null ? n(thr.liqScore, 0).toFixed(3) : "-")}
      </td>
      <td>
        ${kv("maxRange24", dyn.maxRange24 != null ? n(dyn.maxRange24, 0).toFixed(3) : "-")}
        ${kv("dir1hMinBull", dyn.dir1hMinBull != null ? n(dyn.dir1hMinBull, 0).toFixed(3) : "-")}
        ${kv("dir24MinBull", dyn.dir24MinBull != null ? n(dyn.dir24MinBull, 0).toFixed(3) : "-")}
        ${kv("dir1hMaxBear", dyn.dir1hMaxBear != null ? n(dyn.dir1hMaxBear, 0).toFixed(3) : "-")}
        ${kv("dir24MaxBear", dyn.dir24MaxBear != null ? n(dyn.dir24MaxBear, 0).toFixed(3) : "-")}
        ${kv("scale", dyn.scale != null ? n(dyn.scale, 0).toFixed(3) : "-")}
      </td>
      <td>
        ${kv("radar", gates.radar || "-")}
        ${kv("almost", gates.almost || "-")}
        ${kv("entry", gates.entry || "-")}
      </td>
      <td>
        ${kv("cons.ok", cons.ok === true ? "true" : cons.ok === false ? "false" : "-")}
        ${kv("cons.same/need", (cons.same != null && cons.need != null) ? `${cons.same}/${cons.need}` : "-")}
        ${kv("cons.minAgree", cons.minAgree != null ? cons.minAgree : "-")}
        ${an ? kv("anomaly", `${an.type || "?"}`) : kv("anomaly", "-")}
      </td>
    </tr>
  `;
}

function stageTable(title, arr, diagBlockHtml) {
  return `
    <div class="stage">
      <div class="stageHead">
        <div>
          <h3>${esc(title)}</h3>
          <div class="muted">Coins in this table: <b>${arr.length}</b></div>
        </div>
      </div>

      ${diagBlockHtml || ""}

      <div style="overflow:auto;margin-top:10px">
        <table>
          <thead>
            <tr>
              <th>Coin</th>
              <th>Stage</th>
              <th>Conf</th>
              <th>VM</th>
              <th>OB values</th>
              <th>Thresholds</th>
              <th>Dyn</th>
              <th>Gates</th>
              <th>Consistency/Anomaly</th>
            </tr>
          </thead>
          <tbody>
            ${arr.map(coinRow).join("") || `<tr><td colspan="9" class="muted">n/a</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function modeCard(mode, latest, sessionStartMs) {
  const sum = summarizeSnapshot(latest || {});
  const coins = flattenCoins(latest || {});
  const by = {
    RADAR: coins.filter(x => x._bucket === "RADAR"),
    BUILDUP: coins.filter(x => x._bucket === "BUILDUP"),
    ALMOST: coins.filter(x => x._bucket === "ALMOST"),
    ENTRY: coins.filter(x => x._bucket === "ENTRY"),
  };

  // Diagnostics layout (requires scan meta.diagnostics[mode])
  const diag = sum.diagnostics && sum.diagnostics[mode] ? sum.diagnostics[mode] : null;

  const diagForStage = (st) => {
    if (!diag) return `<div class="muted">No diagnostics counters yet (scan must provide latest.meta.diagnostics).</div>`;
    const map =
      st === "RADAR" ? diag.radarRejectReasons :
      st === "BUILDUP" ? diag.buildupRejectReasons :
      st === "ALMOST" ? diag.almostRejectReasons :
      st === "ENTRY" ? diag.entryRejectReasons :
      null;

    return `
      <div class="grid">
        ${renderCounters(`Fail counters — ${st}`, map)}
        ${renderCounters("OB fail counters", diag.obRejectReasons)}
      </div>
    `;
  };

  return `
    <div class="card">
      <div class="cardTop">
        <div>
          <h2>${esc(mode.toUpperCase())}</h2>
          <div class="muted">
            Latest scan: <b>${sum.ts ? fmtDate(sum.ts) : "n/a"}</b> —
            BTC: <b>${esc(sum?.btc?.state || "-")}</b> —
            Session: <b>${sessionStartMs ? fmtDate(sessionStartMs) : "n/a"}</b>
          </div>
          <div class="pills">
            <span class="pill">RADAR: ${n(sum.stageCounts.RADAR, 0)}</span>
            <span class="pill">BUILDUP: ${n(sum.stageCounts.BUILDUP, 0)}</span>
            <span class="pill">ALMOST: ${n(sum.stageCounts.ALMOST, 0)}</span>
            <span class="pill">ENTRY: ${n(sum.stageCounts.ENTRY, 0)}</span>
          </div>
        </div>
      </div>

      <div class="grid" style="margin-top:10px">
        ${renderCounters("Snapshot top radar gates", Object.fromEntries(sum.gateTop.radar.map(x => [x.key, x.count])))}
        ${renderCounters("Snapshot top almost gates", Object.fromEntries(sum.gateTop.almost.map(x => [x.key, x.count])))}
        ${renderCounters("Snapshot top entry gates", Object.fromEntries(sum.gateTop.entry.map(x => [x.key, x.count])))}
        <div class="box">
          <h4>How to tune</h4>
          <div class="muted">
            Gebruik fail counters per stage (diagnostics) om precies te zien welke filter de bottleneck is.
            Snapshot gates zijn handig, maar missen coins die vroeg worden weg-ge-continue’d.
          </div>
        </div>
      </div>

      ${stageTable("RADAR", by.RADAR, diagForStage("RADAR"))}
      ${stageTable("BUILDUP", by.BUILDUP, diagForStage("BUILDUP"))}
      ${stageTable("ALMOST", by.ALMOST, diagForStage("ALMOST"))}
      ${stageTable("ENTRY", by.ENTRY, diagForStage("ENTRY"))}
    </div>
  `;
}

function htmlPage({ bullLatest, bearLatest, events, sessionStartMs }) {
  const flow = summarizeFlow(events, sessionStartMs || (Date.now() - 24 * 3600 * 1000));
  const list = (arr) => (arr || []).map(x => `<li><b>${esc(x.key)}</b> — ${n(x.count,0)}</li>`).join("") || "<li class='muted'>n/a</li>";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Analyze Main</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;margin:0;background:#0b0f14;color:#e6edf3}
    .wrap{max-width:1500px;margin:0 auto;padding:16px}
    h1{margin:0 0 10px 0;font-size:20px}
    .muted{color:#9fb0c3;font-size:13px}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .card{flex:1;min-width:420px;background:#111826;border:1px solid #1f2a3a;border-radius:14px;padding:14px}
    .cardTop{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
    .btn{cursor:pointer;border:1px solid #2a3a52;background:#0c1320;color:#e6edf3;border-radius:12px;padding:10px 12px;font-size:13px}
    .btn:hover{border-color:#3b516f}
    .pill{display:inline-flex;align-items:center;background:#0a1b2b;border:1px solid #15334e;padding:6px 10px;border-radius:999px;font-size:13px;color:#e6edf3}
    .pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    .flow{background:#0c1320;border:1px solid #1f2a3a;border-radius:14px;padding:12px;margin-bottom:12px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}
    .box{background:#0c1320;border:1px solid #1f2a3a;border-radius:12px;padding:10px}
    ul{margin:0;padding-left:18px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:10px;border-bottom:1px solid #1f2a3a;text-align:left;vertical-align:top}
    th{position:sticky;top:0;background:#0e1624}
    .stage{margin-top:14px;padding-top:12px;border-top:1px dashed #233248}
    .stageHead{display:flex;align-items:flex-start;justify-content:space-between}
    .kv{display:flex;gap:8px;align-items:baseline;justify-content:space-between;border-bottom:1px dashed rgba(255,255,255,0.08);padding:2px 0}
    .kv span{color:#9fb0c3}
    code{background:#0c1320;border:1px solid #1f2a3a;padding:2px 6px;border-radius:8px}
  </style>
</head>
<body>
  <div class="wrap">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap">
      <div>
        <h1>Main Analyze — per stage tables + fail counters</h1>
        <div class="muted">
          Session start: <b>${sessionStartMs ? fmtDate(sessionStartMs) : "n/a"}</b>
          &nbsp;•&nbsp; Reset = alleen analyse window (geen scan reset)
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="resetBtn">Reset Analysis</button>
      </div>
    </div>

    <div class="flow">
      <h2 style="margin:0 0 6px 0;font-size:16px">Funnel flow (events) — since session start</h2>
      <div class="grid">
        <div class="box">
          <h3 style="margin:0 0 8px 0;font-size:14px">Top transitions</h3>
          <ul>${list(flow.flowTop)}</ul>
          <div class="muted" style="margin-top:8px">stage_change events: <b>${flow.changesCount}</b></div>
        </div>
        <div class="box">
          <h3 style="margin:0 0 8px 0;font-size:14px">Top reasons (to ALMOST / ENTRY)</h3>
          <div class="grid">
            <div class="box"><h4 style="margin:0 0 6px 0;font-size:13px">To ALMOST</h4><ul>${list(flow.topReasonsTo.ALMOST)}</ul></div>
            <div class="box"><h4 style="margin:0 0 6px 0;font-size:13px">To ENTRY</h4><ul>${list(flow.topReasonsTo.ENTRY)}</ul></div>
          </div>
        </div>
      </div>
      <div class="muted" style="margin-top:8px">
        Tip: voor echte filter bottlenecks heb je scan diagnostics nodig: <code>latest.meta.diagnostics</code>.
      </div>
    </div>

    <div class="row">
      ${modeCard("bull", bullLatest || {}, sessionStartMs)}
      ${modeCard("bear", bearLatest || {}, sessionStartMs)}
    </div>
  </div>

  <script>
    (function(){
      const btn = document.getElementById("resetBtn");
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Resetting...";
        try {
          const url = new URL(window.location.href);
          const secret = url.searchParams.get("secret") || "";
          const r = await fetch("/api/analyze-reset" + (secret ? ("?secret=" + encodeURIComponent(secret)) : ""), { method: "POST" });
          const j = await r.json();
          if (j && j.ok) window.location.reload();
          else alert("Reset failed: " + (j && j.error ? j.error : "unknown"));
        } catch (e) {
          alert("Reset failed: " + String(e && e.message ? e.message : e));
        } finally {
          btn.disabled = false;
          btn.textContent = "Reset Analysis";
        }
      });
    })();
  </script>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const format = String(req.query?.format || "html").toLowerCase();

    const [bullLatest, bearLatest, events, sessionStartMs] = await Promise.all([
      kv.get("latest:bull"),
      kv.get("latest:bear"),
      readEvents("main", 8000),
      kv.get("analyze:sessionStartMs"),
    ]);

    const sess = n(sessionStartMs, 0);

    if (format === "json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({
        ok: true,
        ts: Date.now(),
        view: "analyze-main",
        sessionStartMs: sess,
        latest: { bull: bullLatest || null, bear: bearLatest || null },
        derived: {
          flowSinceSession: summarizeFlow(events, sess || (Date.now() - 24 * 3600 * 1000)),
        },
      }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(htmlPage({ bullLatest, bearLatest, events, sessionStartMs: sess }));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}