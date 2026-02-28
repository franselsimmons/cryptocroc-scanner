// /api/analyze-main.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";
import { readEvents } from "../lib/_analytics.js";

export const config = RUNTIME_CONFIG;

function safeArr(x) { return Array.isArray(x) ? x : []; }
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
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
  return d.toLocaleString("nl-NL", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
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
  return [
    ...safeArr(f.entry).map((c) => ({ ...c, _stage: "ENTRY" })),
    ...safeArr(f.almost).map((c) => ({ ...c, _stage: "ALMOST" })),
    ...safeArr(f.buildup).map((c) => ({ ...c, _stage: "BUILDUP" })),
    ...safeArr(f.radar).map((c) => ({ ...c, _stage: "RADAR" })),
  ];
}

function summarizeLatest(latest) {
  const coins = flattenCoins(latest);
  const stageMap = { RADAR: 0, BUILDUP: 0, ALMOST: 0, ENTRY: 0 };
  const gateMap = {};
  const obReasonMap = {};
  const obStatusMap = {};

  for (const c of coins) {
    const st = String(c?._stage || "RADAR");
    stageMap[st] = (stageMap[st] || 0) + 1;

    const gate = c?.why?.entryGate || "";
    if (gate) inc(gateMap, gate);

    const obStatus = c?.ob?.status || "";
    if (obStatus) inc(obStatusMap, obStatus);

    const obReason = c?.ob?.reason || "";
    if (obReason) inc(obReasonMap, obReason);
  }

  return {
    ts: latest?.ts || null,
    btc: latest?.btc || null,
    stageMap,
    topGate: topN(gateMap, 8),
    topObReason: topN(obReasonMap, 8),
    topObStatus: topN(obStatusMap, 8),
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
    const from = String(e?.from || "").toUpperCase();
    const to = String(e?.to || "").toUpperCase();
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

function htmlPage({ bullLatest, bearLatest, events }) {
  const bullSum = summarizeLatest(bullLatest || {});
  const bearSum = summarizeLatest(bearLatest || {});

  const now = Date.now();
  const flow24h = summarizeFlow(events, now - 24 * 3600 * 1000);
  const flow7d = summarizeFlow(events, now - 7 * 24 * 3600 * 1000);

  const list = (arr) => (arr || []).map((x) => `<li><b>${escapeHtml(x.key)}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";

  const card = (title, sum, mode) => `
    <div class="card">
      <h2>${escapeHtml(title)}</h2>
      <div class="muted">Laatste scan: <b>${sum.ts ? fmtDate(sum.ts) : "n/a"}</b></div>
      <div class="pills">
        <span class="pill">mode: ${escapeHtml(mode)}</span>
        <span class="pill">BTC: ${escapeHtml(sum?.btc?.state || "-")}</span>
      </div>

      <div class="grid">
        <div class="box">
          <h3>Stage counts (snapshot)</h3>
          <ul>
            <li>RADAR: <b>${sum.stageMap.RADAR || 0}</b></li>
            <li>BUILDUP: <b>${sum.stageMap.BUILDUP || 0}</b></li>
            <li>ALMOST: <b>${sum.stageMap.ALMOST || 0}</b></li>
            <li>ENTRY: <b>${sum.stageMap.ENTRY || 0}</b></li>
          </ul>
        </div>

        <div class="box">
          <h3>Top ENTRY gates (snapshot)</h3>
          <ul>${list(sum.topGate)}</ul>
        </div>

        <div class="box">
          <h3>Top OB reasons (snapshot)</h3>
          <ul>${list(sum.topObReason)}</ul>
        </div>

        <div class="box">
          <h3>Top OB status (snapshot)</h3>
          <ul>${list(sum.topObStatus)}</ul>
        </div>
      </div>
    </div>
  `;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>MAIN Analyze</title>
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto;margin:0;background:#0b0f14;color:#e6edf3}
    .wrap{max-width:1100px;margin:0 auto;padding:18px}
    h1{margin:0 0 12px 0;font-size:20px}
    .row{display:flex;gap:12px;flex-wrap:wrap}
    .card{flex:1;min-width:340px;background:#111826;border:1px solid #1f2a3a;border-radius:14px;padding:14px}
    .muted{color:#9fb0c3;font-size:13px}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .box{background:#0c1320;border:1px solid #1f2a3a;border-radius:12px;padding:10px}
    h2{margin:0 0 6px 0;font-size:16px}
    h3{margin:0 0 8px 0;font-size:14px}
    ul{margin:0;padding-left:18px}
    .pills{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0 0}
    .pill{display:inline-flex;align-items:center;background:#0a1b2b;border:1px solid #15334e;padding:6px 10px;border-radius:999px;font-size:13px;color:#e6edf3}
    table th, table td { font-size: 13px; }
    .flow{margin-top:14px;background:#0c1320;border:1px solid #1f2a3a;border-radius:14px;padding:12px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MAIN Analyze (snapshot + echte funnel-flow)</h1>

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

      <h3>Top redenen (7 dagen) — waarom schuiven ze (niet) door</h3>
      <div class="grid">
        <div class="box"><h3>To BUILDUP</h3><ul>${list(flow7d.topReasons.BUILDUP)}</ul></div>
        <div class="box"><h3>To ALMOST</h3><ul>${list(flow7d.topReasons.ALMOST)}</ul></div>
        <div class="box"><h3>To ENTRY</h3><ul>${list(flow7d.topReasons.ENTRY)}</ul></div>
        <div class="box"><h3>To RADAR</h3><ul>${list(flow7d.topReasons.RADAR)}</ul></div>
      </div>
    </div>

    <div class="row" style="margin-top:12px">
      ${card("LONG (bull)", bullSum, "bull")}
      ${card("SHORT (bear)", bearSum, "bear")}
    </div>

    <div class="muted" style="margin-top:10px">
      Tip: <code>?format=json</code> voor ruwe data.
    </div>
  </div>
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
    return res.end(htmlPage({ bullLatest, bearLatest, events }));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}