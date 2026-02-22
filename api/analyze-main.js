// /api/analyze-main.js
import { kv } from "@vercel/kv";
import { readAllTrades } from "../lib/_trades_kv.js";

export const config = { runtime: "nodejs" };

/* rest EXACT hetzelfde als jij stuurde */
// ✅ cores cache (1x laden, daarna hergebruiken) — imports uit /lib
let __bull = null;
let __bear = null;

async function loadCores() {
  if (!__bull) __bull = await import("../lib/_core_bull.js");
  if (!__bear) __bear = await import("../lib/_core_bear.js");
  return { bull: __bull, bear: __bear };
}

// ✅ getCfg zoals vroeger: geeft config-object terug (liefst core.getCfg, anders core.SETTINGS)
function getCfg(mode) {
  const m = String(mode || "bull").toLowerCase();
  const core = m === "bear" ? __bear : __bull;
  if (!core) return null; // handler laadt eerst loadCores()
  return typeof core.getCfg === "function" ? core.getCfg(m) : core.SETTINGS;
}

// ======================================================
// KV KEYS
// ======================================================
const keyLatest = (mode) => `latest:${String(mode || "bull")}`;
const keyEvents = `events:main`;

// ======================================================
// HELPERS
// ======================================================
function safeArr(x) { return Array.isArray(x) ? x : []; }
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function topN(map, k = 6) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function inc(map, key) { const k = String(key || "Unknown"); map[k] = (map[k] || 0) + 1; return map; }
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function fmtDateMin(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "n/a";
  return d.toLocaleString("nl-NL", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
function pct(x, digits = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return `${v.toFixed(digits)}%`;
}

// ======================================================
// READ
// ======================================================
async function readEvents(max = 500) {
  // ✅ events = LIST
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyEvents, 0, Math.max(0, max - 1));
      return safeArr(raw)
        .map((x) => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; } })
        .filter(Boolean);
    }
  } catch {}
  return [];
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
    topGate: topN(gateMap, 5),
    topObReason: topN(obReasonMap, 5),
    topObStatus: topN(obStatusMap, 5),
    coins,
  };
}

// Trades tuning (zelfde als je al had)
function tradeOutcome(t) {
  const mode = String(t?.mode || "bull");
  const last = n(t?.lastPrice, 0);
  const sl = n(t?.sl, 0);
  const tp = n(t?.tp, 0);

  const status = String(t?.status || "OPEN").toUpperCase();
  if (status !== "CLOSED") return "OPEN";

  if (mode === "bull") {
    if (sl > 0 && last > 0 && last <= sl) return "SL";
    if (tp > 0 && last > 0 && last >= tp) return "TP";
  } else {
    if (sl > 0 && last > 0 && last >= sl) return "SL";
    if (tp > 0 && last > 0 && last <= tp) return "TP";
  }

  const pnl = n(t?.pnlPct, 0);
  if (pnl >= 0.1) return "WIN";
  if (pnl <= -0.1) return "LOSS";
  return "FLAT";
}

function summarizeTrades(trades, funnel) {
  const filtered = trades.filter(t => t.funnel === funnel);
  const open = filtered.filter((t) => String(t?.status || "").toUpperCase() === "OPEN");
  const closed = filtered.filter((t) => String(t?.status || "").toUpperCase() === "CLOSED");

  const outMap = {};
  for (const t of closed) inc(outMap, tradeOutcome(t));

  return {
    counts: { open: open.length, closed: closed.length, total: filtered.length },
    outcomesTop: topN(outMap, 8),
    sampleClosed: closed.slice(-10),
  };
}

function buildCopyPayload({ mode, latestSummary, tradeSum }) {
  const CFG = getCfg(mode);
  const entry = CFG?.entry || {};
  const buildup = CFG?.buildup || {};
  const almost = CFG?.almost || {};
  const sizing = CFG?.sizing || {};
  return {
    funnel: "main",
    mode,
    ts: Date.now(),
    lastScanTs: latestSummary?.ts || null,
    btc: latestSummary?.btc || null,
    stageCounts: latestSummary?.stageMap || {},
    topEntryGates: latestSummary?.topGate || [],
    topObReasons: latestSummary?.topObReason || [],
    topObStatus: latestSummary?.topObStatus || [],
    trades: {
      counts: tradeSum?.counts || {},
      outcomesTop: tradeSum?.outcomesTop || [],
    },
    filters: {
      universe: { CG_TOP: CFG.CG_TOP, RADAR_LIMIT: CFG.RADAR_LIMIT },
      radar: {
        mcapMin: CFG.mcapMin,
        mcapMax: CFG.mcapMax,
        volMinRadar: CFG.volMinRadar,
        vmMinRadar: CFG.vmMinRadar,
        maxAbsChg24: CFG.maxAbsChg24,
        maxRange24: CFG.maxRange24,
      },
      btcGate: {
        btcChgGate: CFG.btcChgGate,
        btcRangeMin: CFG.btcRangeMin,
        btcRangeMaxBull: CFG.btcRangeMaxBull,
        btcRangeMaxBear: CFG.btcRangeMaxBear,
      },
      buildup,
      almost,
    },
    ob: {
      obScoreMin: entry.obScoreMin,
      spreadMaxPct: entry.spreadMaxPct,
      largestOrderRatioMax: entry.largestOrderRatioMax,
      samplesNeed: entry.samplesNeed,
      samplesWindowSec: entry.samplesWindowSec,
      minAgree: entry.minAgree,
      minDepthUsd1pBull: entry.minDepthUsd1pBull,
      minDepthUsd1pBear: entry.minDepthUsd1pBear,
      minConfidence: entry.minConfidence,
      entryConsistencyMin: entry.entryConsistencyMin,
      obSlopeEnabled: entry.obSlopeEnabled,
      obSlopeMinBull: entry.obSlopeMinBull,
      obSlopeMaxBear: entry.obSlopeMaxBear,
      allowValidatingForAlmost: entry.allowValidatingForAlmost,
      minConfidenceAlmost: entry.minConfidenceAlmost,
      minConsistencyAlmost: entry.minConsistencyAlmost,
    },
    sizing,
  };
}

function renderCopyBlock(id, payload) {
  const txt = escapeHtml(JSON.stringify(payload, null, 2));
  return `
    <div class="box" style="grid-column: 1 / -1">
      <h3>Kopieer & plak (voor aanpassen filters/OB)</h3>
      <div class="muted">Plak dit hier in de chat. Dan zeg ik exact wat je moet veranderen.</div>
      <textarea id="${id}" style="width:100%;min-height:220px;margin-top:8px;background:#071421;color:#e6edf3;border:1px solid #15334e;border-radius:10px;padding:10px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-size:12px;">${txt}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="copyText('${id}')" style="background:#111826;color:#e6edf3;border:1px solid #1f2a3a;border-radius:10px;padding:8px 10px;cursor:pointer">Copy</button>
      </div>
    </div>
  `;
}

// ===== NIEUW: recommendMainChanges & buildCopyBlockMain =====
function recommendMainChanges(derived, cfg) {
  const gates = derived?.topGate || [];
  const ob = derived?.topObReason || [];
  const topGate = String(gates[0]?.key || "");
  const topOb = String(ob[0]?.key || "");

  const changes = {};

  // voorbeeld: als validating / not enough samples dominant zijn, stel samplesWindowSec voor
  if (topGate.toLowerCase().includes("validating") || topOb.toLowerCase().includes("not enough samples")) {
    changes["SETTINGS.entry.samplesWindowSec"] = `${cfg.entry.samplesWindowSec} -> 900`;
    // eventueel ook samplesNeed verlagen:
    // changes["SETTINGS.entry.samplesNeed"] = `${SETTINGS.entry.samplesNeed} -> 1`;
  }

  return changes;
}

function buildCopyBlockMain({ mode, latest, derived, tradeSum }) {
  const CFG = getCfg(mode);
  return {
    funnel: "main",
    mode,
    ts: Date.now(),
    btc: latest?.btc || null,
    stageCounts: derived?.stageMap || null,
    topEntryGates: derived?.topGate || [],
    topObReasons: derived?.topObReason || [],
    topObStatus: derived?.topObStatus || [],
    trades: tradeSum || null,

    // ✅ HUIDIGE instellingen (de waarheid)
    filtersNow: {
      universe: { CG_TOP: CFG.CG_TOP, RADAR_LIMIT: CFG.RADAR_LIMIT },
      radar: {
        mcapMin: CFG.mcapMin,
        mcapMax: CFG.mcapMax,
        volMinRadar: CFG.volMinRadar,
        vmMinRadar: CFG.vmMinRadar,
        maxAbsChg24: CFG.maxAbsChg24,
        maxRange24: CFG.maxRange24,
      },
      btcGate: {
        btcChgGate: CFG.btcChgGate,
        btcRangeMin: CFG.btcRangeMin,
        btcRangeMaxBull: CFG.btcRangeMaxBull,
        btcRangeMaxBear: CFG.btcRangeMaxBear,
      },
      buildup: CFG.buildup,
      almost: CFG.almost,
      ob: CFG.entry,
      risk: CFG.risk,
      riskWhere: {
        file: "/api/_core_bull.js + /api/_core_bear.js",
        sltpFunc: "computeSLTP",
        atrFunc: "computeAtrPctFromPriceHist",
      },
    },

    // ✅ Analyzer advies
    recommendedChanges: recommendMainChanges(derived, CFG),
  };
}

function htmlPage({ longLatest, shortLatest, trades, events }) {
  const longSum = summarizeLatest(longLatest || {});
  const shortSum = summarizeLatest(shortLatest || {});
  const tradeSumMain = summarizeTrades(trades, "main");

  const lastEv = safeArr(events).slice(-1)[0] || null;

  const badge = (state) => {
    const s = String(state || "").toUpperCase();
    if (s === "BULL") return `<span class="pill ok">BTC: BULL</span>`;
    if (s === "BEAR") return `<span class="pill bad">BTC: BEAR</span>`;
    return `<span class="pill warn">BTC: ${s || "-"}</span>`;
  };

  const list = (arr) =>
    (arr || []).map((x) => `<li><b>${x.key}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";

  const card = (title, sum, mode, latestRaw) => {
    const copyId = `copy_main_${mode}`;
    const payload = buildCopyPayload({ mode, latestSummary: sum, tradeSum: tradeSumMain });

    // Nieuw copy-blok voor MAIN
    const copyBlock = buildCopyBlockMain({ mode, latest: latestRaw, derived: sum, tradeSum: tradeSumMain });
    const copyHtml = `
      <div class="box" style="margin-top:12px;grid-column:1/-1">
        <h3>📋 Copy/paste (MAIN) — filters + top blokkades + advies</h3>
        <div class="muted">Kopieer dit en plak het hier in de chat, dan kan ik exact zeggen wat je moet veranderen.</div>
        <textarea style="width:100%;height:260px;margin-top:8px;background:#0a1b2b;color:#e6edf3;border:1px solid #15334e;border-radius:10px;padding:10px;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${escapeHtml(JSON.stringify(copyBlock, null, 2))}</textarea>
      </div>
    `;

    return `
      <div class="card">
        <h2>${title}</h2>
        <div class="muted">Laatste scan: <b>${sum.ts ? fmtDateMin(sum.ts) : "n/a"}</b></div>

        <div class="pills">
          ${badge(sum?.btc?.state)}
          <span class="pill">mode: ${escapeHtml(mode)}</span>
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
            <h3>Trades (MAIN) — quick</h3>
            <div class="muted">Open: <b>${tradeSumMain.counts.open}</b> • Closed: <b>${tradeSumMain.counts.closed}</b></div>
            <ul>${list(tradeSumMain.outcomesTop)}</ul>
          </div>
        </div>

        <div class="grid">
          <div class="box">
            <h3>Top ENTRY gates</h3>
            <ul>${list(sum.topGate)}</ul>
          </div>
          <div class="box">
            <h3>Top OB reasons</h3>
            <ul>${list(sum.topObReason)}</ul>
          </div>
          <div class="box">
            <h3>Top OB status</h3>
            <ul>${list(sum.topObStatus)}</ul>
          </div>
          <div class="box">
            <h3>Events</h3>
            <ul>
              <li>events (list): <b>${safeArr(events).length}</b></li>
              <li>laatste event: <b>${lastEv?.ts ? fmtDateMin(lastEv.ts) : "n/a"}</b></li>
            </ul>
          </div>

          ${renderCopyBlock(copyId, payload)}
        </div>

        <div class="box" style="margin-top:10px">
          <h3>Coins (eerste 20)</h3>
          <div class="muted">Stage + OB + Gate (handig om te zien waar ze hangen)</div>
          <div style="overflow:auto;border:1px solid #1f2a3a;border-radius:12px;margin-top:8px">
            <table style="width:100%;border-collapse:collapse;min-width:900px">
              <thead>
                <tr>
                  <th style="text-align:left;padding:8px;border-bottom:1px solid #1f2a3a">Coin</th>
                  <th style="text-align:left;padding:8px;border-bottom:1px solid #1f2a3a">Stage</th>
                  <th style="text-align:left;padding:8px;border-bottom:1px solid #1f2a3a">24h</th>
                  <th style="text-align:left;padding:8px;border-bottom:1px solid #1f2a3a">VM</th>
                  <th style="text-align:left;padding:8px;border-bottom:1px solid #1f2a3a">OB</th>
                  <th style="text-align:left;padding:8px;border-bottom:1px solid #1f2a3a">OB reason</th>
                  <th style="text-align:left;padding:8px;border-bottom:1px solid #1f2a3a">Gate</th>
                </tr>
              </thead>
              <tbody>
                ${safeArr(sum.coins).slice(0, 20).map((c) => {
                  const ob = c?.ob || {};
                  const why = c?.why || {};
                  return `
                    <tr>
                      <td style="padding:8px;border-bottom:1px solid #1f2a3a"><b>${escapeHtml(c?.symbol || "-")}</b> <span style="color:#9fb0c3">${escapeHtml(c?.name || "")}</span></td>
                      <td style="padding:8px;border-bottom:1px solid #1f2a3a">${escapeHtml(c?._stage || "-")}</td>
                      <td style="padding:8px;border-bottom:1px solid #1f2a3a">${pct(c?.change24, 2)}</td>
                      <td style="padding:8px;border-bottom:1px solid #1f2a3a">${n(c?.vm, 0).toFixed(3)}</td>
                      <td style="padding:8px;border-bottom:1px solid #1f2a3a">${ob?.valid ? "valid" : escapeHtml(ob?.status || "n/a")}</td>
                      <td style="padding:8px;border-bottom:1px solid #1f2a3a">${escapeHtml(ob?.reason || "-")}</td>
                      <td style="padding:8px;border-bottom:1px solid #1f2a3a">${escapeHtml(why?.entryGate || "-")}</td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>

        ${copyHtml} <!-- nieuw uitgebreid copy-blok -->
      </div>
    `;
  };

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
    .pill.ok{border-color:rgba(25,195,125,.5)}
    .pill.warn{border-color:rgba(246,193,119,.6)}
    .pill.bad{border-color:rgba(255,107,107,.6)}
    code{background:#0a1b2b;border:1px solid #15334e;padding:2px 6px;border-radius:8px}
    table th, table td { font-size: 13px; }
  </style>
  <script>
    function copyText(id){
      var el = document.getElementById(id);
      if(!el) return;
      el.select();
      el.setSelectionRange(0, 999999);
      try { document.execCommand('copy'); } catch (e) {}
    }
  </script>
</head>
<body>
  <div class="wrap">
    <h1>MAIN Analyze (zelfde stijl als MOON) + Copy/Paste</h1>
    <div class="row">
      ${card("LONG (bull)", longSum, "bull", longLatest)}
      ${card("SHORT (bear)", shortSum, "bear", shortLatest)}
    </div>
    <div class="muted" style="margin-top:10px">
      Tip: voeg <code>?format=json</code> toe als je de ruwe data wil zien.
    </div>
  </div>
</body>
</html>`;
}

export default async function handler(req, res) {
  try {
    const { bull } = await loadCores();
    if (!bull.requireSecret(req, res)) return;

    const format = String(req.query?.format || "html").toLowerCase();

    const { bear } = await loadCores(); // hergebruik cache
    const SETTINGS = { bull: bull.SETTINGS, bear: bear.SETTINGS };

    const longLatest = await kv.get(keyLatest("bull"));
    const shortLatest = await kv.get(keyLatest("bear"));

    const tradesAll = await readAllTrades(500, 500);
    const trades = tradesAll.all; // alle trades (main + moon), we filteren later

    const events = await readEvents(500);

    if (format === "json") {
      const longSum = summarizeLatest(longLatest || {});
      const shortSum = summarizeLatest(shortLatest || {});
      const tradeSumMain = summarizeTrades(trades, "main");

      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify({
        ok: true,
        ts: Date.now(),
        view: "analyze-main",
        settings: SETTINGS,
        latest: { bull: longLatest, bear: shortLatest },
        derived: { bull: longSum, bear: shortSum, trades: tradeSumMain },
        eventsCount: safeArr(events).length,
      }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(htmlPage({ longLatest, shortLatest, trades, events }));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}