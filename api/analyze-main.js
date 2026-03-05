// /api/analyze-main.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";
import { readEvents } from "../lib/_analytics.js";

export const config = RUNTIME_CONFIG;

function safeArr(x) { return Array.isArray(x) ? x : []; }
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function up(x) { return String(x || "").toUpperCase(); }

function escapeHtml(s) {
  return String(s || "")
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
    hour: "2-digit", minute: "2-digit"
  });
}

function topN(map, k = 8) {
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
  // preserve existing stage field if present, but also add _stage from bucket
  return [
    ...safeArr(f.entry).map((c) => ({ ...c, _stage: "ENTRY" })),
    ...safeArr(f.almost).map((c) => ({ ...c, _stage: "ALMOST" })),
    ...safeArr(f.buildup).map((c) => ({ ...c, _stage: "BUILDUP" })),
    ...safeArr(f.radar).map((c) => ({ ...c, _stage: "RADAR" })),
  ];
}

function gateStr(x) {
  const s = String(x ?? "").trim();
  return s || "n/a";
}

function summarizeLatest(latest) {
  const coins = flattenCoins(latest);
  const stageMap = { RADAR: 0, BUILDUP: 0, ALMOST: 0, ENTRY: 0 };

  const gateRadar = {};
  const gateAlmost = {};
  const gateEntry = {};

  const obReasonMap = {};
  const obFreshMap = {};
  const obValidMap = {};

  for (const c of coins) {
    const st = up(c?._stage || "RADAR");
    stageMap[st] = (stageMap[st] || 0) + 1;

    // gates from scan.js output
    const g = c?.gates || {};
    const gr = gateStr(g?.radar);
    const ga = gateStr(g?.almost);
    const ge = gateStr(g?.entry);

    if (gr) inc(gateRadar, gr);
    if (ga && ga !== "n/a") inc(gateAlmost, ga);
    if (ge && ge !== "n/a") inc(gateEntry, ge);

    // ob summary
    const ob = c?.ob || {};
    const reason = String(ob?.reason || "");
    if (reason) inc(obReasonMap, reason);

    inc(obFreshMap, String(!!ob?.fresh));
    inc(obValidMap, String(!!ob?.valid));
  }

  // simple suggestion: biggest bottleneck across almost/entry
  const topAlmost = topN(gateAlmost, 6);
  const topEntry = topN(gateEntry, 6);
  const topRadar = topN(gateRadar, 6);

  const suggestion = [];
  const lower = (s) => String(s || "").toLowerCase();

  const anySpread = topAlmost.concat(topEntry).some(x => lower(x.key).includes("spread>"));
  const anyDepth = topAlmost.concat(topEntry).some(x => lower(x.key).includes("depth"));
  const anyObScore = topAlmost.concat(topEntry).some(x => lower(x.key).includes("obscore") || lower(x.key).includes("|obscore|"));
  const anyConsistency = topAlmost.concat(topEntry).some(x => lower(x.key).includes("consistency"));
  const anySpoof = topAlmost.some(x => lower(x.key).includes("spoof"));

  if (anySpread) suggestion.push("Many coins fail on spread. Consider relaxing spreadMaxPct slightly for ALMOST (or improve OB sampling quality).");
  if (anyDepth) suggestion.push("Many coins fail on depthMinUsd1p. Consider lowering the depth threshold or filtering to higher-liquidity coins earlier.");
  if (anyObScore) suggestion.push("Many coins fail on |obScore|. Consider lowering obScoreAbsMin slightly or improving score signal stability.");
  if (anyConsistency) suggestion.push("Consistency blocks many promotions. Consider adjusting samplesNeed/minAgree or scan cadence.");
  if (anySpoof) suggestion.push("Spoof risk blocks coins at ALMOST. Consider raising minForSpoof or loosening spoof risk scoring if too strict.");

  return {
    ts: latest?.ts || null,
    btc: latest?.btc || null,
    stageMap,
    topRadarGate: topRadar,
    topAlmostGate: topAlmost,
    topEntryGate: topEntry,
    topObReason: topN(obReasonMap, 8),
    obFresh: topN(obFreshMap, 4),
    obValid: topN(obValidMap, 4),
    suggestion,
  };
}

function summarizeFlow(events, sinceMs) {
  const changes = safeArr(events)
    .filter((e) => e?.type === "stage_change")
    .filter((e) => n(e?.ts, 0) >= sinceMs);

  const flow = {
    RADAR_TO_BUILDUP: 0,
    BUILDUP_TO_ALMOST: 0,
    ALMOST_TO_ENTRY: 0,
    OTHER: 0,
  };

  const reasons = { BUILDUP: {}, ALMOST: {}, ENTRY: {}, RADAR: {} };

  for (const e of changes) {
    const from = up(e?.from || "");
    const to = up(e?.to || "");
    const r = String(e?.reason || "unknown");

    if (from === "RADAR" && to === "BUILDUP") flow.RADAR_TO_BUILDUP++;
    else if (from === "BUILDUP" && to === "ALMOST") flow.BUILDUP_TO_ALMOST++;
    else if (from === "ALMOST" && to === "ENTRY") flow.ALMOST_TO_ENTRY++;
    else flow.OTHER++;

    if (to && reasons[to]) inc(reasons[to], r);
  }

  return {
    sinceMs,
    changesCount: changes.length,
    flow,
    topReasons: {
      BUILDUP: topN(reasons.BUILDUP, 8),
      ALMOST: topN(reasons.ALMOST, 8),
      ENTRY: topN(reasons.ENTRY, 8),
      RADAR: topN(reasons.RADAR, 8),
    },
  };
}

function coinsByStage(latest) {
  const coins = flattenCoins(latest);
  const out = { RADAR: [], BUILDUP: [], ALMOST: [], ENTRY: [] };
  for (const c of coins) {
    const st = up(c?._stage || "RADAR");
    if (!out[st]) out[st] = [];
    out[st].push(c);
  }
  return out;
}

function sortCoins(arr) {
  const a = safeArr(arr).slice();
  a.sort((x, y) => (n(y?.confidence, 0) - n(x?.confidence, 0)) || (n(y?.vm, 0) - n(x?.vm, 0)));
  return a;
}

function rowCoin(c) {
  const sym = escapeHtml(c?.symbol || "?");
  const name = escapeHtml(c?.name || "");
  const g = c?.gates || {};
  const ob = c?.ob || {};
  const thr = c?.thr || {};
  const cs = c?.coinStats || {};
  const an = c?.anomaly || null;

  return `
    <tr>
      <td><b>${sym}</b><div class="muted">${name}</div></td>
      <td>${escapeHtml(String(c?._stage || c?.stage || ""))}</td>
      <td>${n(c?.confidence, 0)}</td>
      <td>${n(c?.vm, 0).toFixed(4)}</td>

      <td class="mono">${escapeHtml(gateStr(g?.radar))}</td>
      <td class="mono">${escapeHtml(gateStr(g?.almost))}</td>
      <td class="mono">${escapeHtml(gateStr(g?.entry))}</td>

      <td>${n(ob?.spreadPct, NaN)}</td>
      <td>${n(ob?.depthMinUsd1p, NaN)}</td>
      <td>${n(ob?.score, NaN)}</td>
      <td>${n(ob?.pressureDeltaUsd, 0)}</td>
      <td>${escapeHtml(String(!!ob?.fresh))}/${escapeHtml(String(!!ob?.valid))}</td>

      <td>${n(thr?.minConfidence, NaN)}</td>
      <td>${n(thr?.spreadMaxPct, NaN)}</td>
      <td>${n(thr?.depthMinUsd1p, NaN)}</td>
      <td>${n(thr?.obScoreMin, NaN)}</td>

      <td>${n(cs?.samples, 0)}</td>
      <td>${Number.isFinite(Number(cs?.medSpreadPct)) ? n(cs.medSpreadPct,0).toFixed(3) : ""}</td>
      <td>${Number.isFinite(Number(cs?.p80SpreadPct)) ? n(cs.p80SpreadPct,0).toFixed(3) : ""}</td>
      <td>${Number.isFinite(Number(cs?.p70ObAbs)) ? n(cs.p70ObAbs,0).toFixed(5) : ""}</td>

      <td class="mono">${an ? escapeHtml(`${an.type || "ANOM"} ${an.factor ? "x"+an.factor : ""}`) : ""}</td>
    </tr>
  `;
}

function tableCoins(title, coins) {
  const rows = sortCoins(coins).map(rowCoin).join("") || `<tr><td colspan="21" class="muted">n/a</td></tr>`;
  return `
    <div class="box" style="margin-top:12px">
      <h3>${escapeHtml(title)} (${safeArr(coins).length})</h3>
      <div class="muted">Per coin: gates + OB + thresholds + coinStats. Dit is je “alles in elke tabel”.</div>
      <div style="overflow:auto;margin-top:8px">
        <table>
          <thead>
            <tr>
              <th>Coin</th>
              <th>Stage</th>
              <th>Conf</th>
              <th>VM</th>

              <th>Gate: radar</th>
              <th>Gate: almost</th>
              <th>Gate: entry</th>

              <th>OB spread%</th>
              <th>OB depth1%</th>
              <th>OB score</th>
              <th>OB pressureΔ</th>
              <th>OB fresh/valid</th>

              <th>thr minConf</th>
              <th>thr spreadMax</th>
              <th>thr depthMin</th>
              <th>thr obScoreMin</th>

              <th>stats n</th>
              <th>stats medSpread</th>
              <th>stats p80Spread</th>
              <th>stats p70ObAbs</th>

              <th>anomaly</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function listItems(arr) {
  const li = (arr || []).map((x) => `<li><b>${escapeHtml(x.key)}</b> — ${n(x.count, 0)}</li>`).join("");
  return li || "<li>n/a</li>";
}

function resetBlockScript() {
  return `
<script>
  function resetAnalyze() {
    try {
      // remove query params
      const url = new URL(window.location.href);
      url.search = "";

      // remove analysis UI state only (prefixes)
      const prefixes = ["analyze:", "analyzeMain:", "an:"];
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (prefixes.some(p => k.startsWith(p))) keysToRemove.push(k);
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));

      // reload clean
      window.location.href = url.pathname;
    } catch (e) {
      alert("Reset failed: " + (e && e.message ? e.message : String(e)));
    }
  }
</script>`;
}

function htmlPage({ bullLatest, bearLatest, events }) {
  const bull = bullLatest || {};
  const bear = bearLatest || {};

  const bullSum = summarizeLatest(bull);
  const bearSum = summarizeLatest(bear);

  const now = Date.now();
  const flow24h = summarizeFlow(events, now - 24 * 3600 * 1000);
  const flow7d = summarizeFlow(events, now - 7 * 24 * 3600 * 1000);

  const bullStages = coinsByStage(bull);
  const bearStages = coinsByStage(bear);

  const card = (title, sum, mode) => `
    <div class="card">
      <h2>${escapeHtml(title)}</h2>
      <div class="muted">Latest scan: <b>${sum.ts ? fmtDate(sum.ts) : "n/a"}</b></div>
      <div class="pills">
        <span class="pill">mode: ${escapeHtml(mode)}</span>
        <span class="pill">BTC: ${escapeHtml(sum?.btc?.state || "-")}</span>
      </div>

      <div class="grid">
        <div class="box">
          <h3>Stage counts</h3>
          <ul>
            <li>RADAR: <b>${sum.stageMap.RADAR || 0}</b></li>
            <li>BUILDUP: <b>${sum.stageMap.BUILDUP || 0}</b></li>
            <li>ALMOST: <b>${sum.stageMap.ALMOST || 0}</b></li>
            <li>ENTRY: <b>${sum.stageMap.ENTRY || 0}</b></li>
          </ul>
        </div>

        <div class="box">
          <h3>Top RADAR gates</h3>
          <ul>${listItems(sum.topRadarGate)}</ul>
        </div>

        <div class="box">
          <h3>Top ALMOST gates</h3>
          <ul>${listItems(sum.topAlmostGate)}</ul>
        </div>

        <div class="box">
          <h3>Top ENTRY gates</h3>
          <ul>${listItems(sum.topEntryGate)}</ul>
        </div>

        <div class="box">
          <h3>Top OB reasons</h3>
          <ul>${listItems(sum.topObReason)}</ul>
        </div>

        <div class="box">
          <h3>Best suggestions</h3>
          <ul>${(sum.suggestion || []).map(s => `<li>${escapeHtml(s)}</li>`).join("") || "<li>n/a</li>"}</ul>
        </div>
      </div>
    </div>
  `;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Analyze MAIN</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;margin:0;background:#0b0f14;color:#e6edf3}
    .wrap{max-width:1250px;margin:0 auto;padding:18px}
    h1{margin:0 0 8px 0;font-size:20px}
    .muted{color:#9fb0c3;font-size:13px}
    .row{display:flex;gap:12px;flex-wrap:wrap;margin-top:12px}
    .card{flex:1;min-width:360px;background:#111826;border:1px solid #1f2a3a;border-radius:14px;padding:14px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .box{background:#0c1320;border:1px solid #1f2a3a;border-radius:12px;padding:10px}
    h2{margin:0 0 6px 0;font-size:16px}
    h3{margin:0 0 8px 0;font-size:14px}
    ul{margin:0;padding-left:18px}
    .pills{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0 0}
    .pill{display:inline-flex;align-items:center;background:#0a1b2b;border:1px solid #15334e;padding:6px 10px;border-radius:999px;font-size:13px;color:#e6edf3}
    .flow{margin-top:14px;background:#0c1320;border:1px solid #1f2a3a;border-radius:14px;padding:12px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{padding:8px;border-bottom:1px solid #1f2a3a;text-align:left;vertical-align:top}
    th{position:sticky;top:0;background:#0b0f14}
    .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:12px;white-space:nowrap}
    .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0 0 0}
    .btn{cursor:pointer;border-radius:10px;border:1px solid #2b3a50;background:#0a1b2b;color:#e6edf3;padding:10px 12px}
    .btn:hover{border-color:#3a5273}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Analyze MAIN — “each filter / each table / each coin”</h1>

    <div class="bar">
      <button class="btn" onclick="resetAnalyze()">Reset analyse</button>
      <span class="muted">Reset alleen deze analyse pagina (filters/URL/localStorage). Backend data blijft hetzelfde.</span>
    </div>

    <div class="flow">
      <h2>Funnel flow (events)</h2>
      <div class="muted">Scan logt stage_change events. Hier zie je doorstroom + bottlenecks.</div>

      <h3>Laatste 24 uur</h3>
      <ul>
        <li>RADAR → BUILDUP: <b>${flow24h.flow.RADAR_TO_BUILDUP}</b></li>
        <li>BUILDUP → ALMOST: <b>${flow24h.flow.BUILDUP_TO_ALMOST}</b></li>
        <li>ALMOST → ENTRY: <b>${flow24h.flow.ALMOST_TO_ENTRY}</b></li>
        <li>Events totaal: <b>${flow24h.changesCount}</b></li>
      </ul>

      <h3>Laatste 7 dagen</h3>
      <ul>
        <li>RADAR → BUILDUP: <b>${flow7d.flow.RADAR_TO_BUILDUP}</b></li>
        <li>BUILDUP → ALMOST: <b>${flow7d.flow.BUILDUP_TO_ALMOST}</b></li>
        <li>ALMOST → ENTRY: <b>${flow7d.flow.ALMOST_TO_ENTRY}</b></li>
        <li>Events totaal: <b>${flow7d.changesCount}</b></li>
      </ul>

      <h3>Top redenen (7 dagen)</h3>
      <div class="grid">
        <div class="box"><h3>To BUILDUP</h3><ul>${listItems(flow7d.topReasons.BUILDUP)}</ul></div>
        <div class="box"><h3>To ALMOST</h3><ul>${listItems(flow7d.topReasons.ALMOST)}</ul></div>
        <div class="box"><h3>To ENTRY</h3><ul>${listItems(flow7d.topReasons.ENTRY)}</ul></div>
        <div class="box"><h3>To RADAR</h3><ul>${listItems(flow7d.topReasons.RADAR)}</ul></div>
      </div>
    </div>

    <div class="row">
      ${card("LONG (bull)", bullSum, "bull")}
      ${card("SHORT (bear)", bearSum, "bear")}
    </div>

    ${tableCoins("BULL — RADAR", bullStages.RADAR)}
    ${tableCoins("BULL — BUILDUP", bullStages.BUILDUP)}
    ${tableCoins("BULL — ALMOST", bullStages.ALMOST)}
    ${tableCoins("BULL — ENTRY", bullStages.ENTRY)}

    ${tableCoins("BEAR — RADAR", bearStages.RADAR)}
    ${tableCoins("BEAR — BUILDUP", bearStages.BUILDUP)}
    ${tableCoins("BEAR — ALMOST", bearStages.ALMOST)}
    ${tableCoins("BEAR — ENTRY", bearStages.ENTRY)}

    <div class="muted" style="margin-top:10px">
      Tip: <code>?format=json</code> voor ruwe data.
    </div>
  </div>
  ${resetBlockScript()}
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const format = String(req.query?.format || "html").toLowerCase();

    const [bullLatest, bearLatest, events] = await Promise.all([
      kv.get("latest:bull"),
      kv.get("latest:bear"),
      readEvents("main", 5000),
    ]);

    if (format === "json") {
      const now = Date.now();
      const flow24h = summarizeFlow(events, now - 24 * 3600 * 1000);
      const flow7d = summarizeFlow(events, now - 7 * 24 * 3600 * 1000);

      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({
        ok: true,
        ts: Date.now(),
        view: "analyze-main",
        latest: { bull: bullLatest || null, bear: bearLatest || null },
        derived: {
          bull: summarizeLatest(bullLatest || {}),
          bear: summarizeLatest(bearLatest || {}),
          flow24h,
          flow7d,
          eventsCount: safeArr(events).length,
        },
      }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(htmlPage({ bullLatest, bearLatest, events }));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}