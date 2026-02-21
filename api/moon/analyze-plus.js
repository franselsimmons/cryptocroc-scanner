// /api/moon-analyze-plus.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  MOON,
  keyMoonDiagList,
  keyMoonDiagSnap,
  keyMoonPositions,
  keyMoonPortfolio,
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

// ===== helpers =====
function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
function normalizeMode(v) {
  const m = String(v || "all").toLowerCase();
  if (m === "long" || m === "bull") return "bull";
  if (m === "short" || m === "bear") return "bear";
  return "all";
}
function label(mode) {
  return mode === "bull" ? "LONG" : "SHORT";
}
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function topN(map, k = 6) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count: n(count, 0) }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}
function addCounts(to, from) {
  const out = to || {};
  const src = from || {};
  for (const k of Object.keys(src)) out[k] = (out[k] || 0) + n(src[k], 0);
  return out;
}
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

async function readDiags(mode, limit) {
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyMoonDiagList(mode), 0, Math.max(0, limit - 1));
      return (raw || [])
        .map((x) => {
          try {
            return typeof x === "string" ? JSON.parse(x) : x;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
    const snap = await kv.get(keyMoonDiagSnap(mode));
    return snap ? [snap] : [];
  } catch {
    return [];
  }
}

async function readPositions(mode) {
  try {
    const p = await kv.get(keyMoonPositions(mode));
    // verwacht { open:[], closed:[] } maar we blijven safe
    return {
      open: Array.isArray(p?.open) ? p.open : [],
      closed: Array.isArray(p?.closed) ? p.closed : [],
    };
  } catch {
    return { open: [], closed: [] };
  }
}

async function readPortfolio(mode) {
  try {
    const p = await kv.get(keyMoonPortfolio(mode));
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

function summarizeDiags(diags) {
  const s = {
    scans: diags.length,
    lastTs: diags[0]?.ts || null,
    avg: { radar: 0, buildup: 0, almost: 0, elite: 0 },
    totals: {
      radarOut: {},
      buildupWhy: {},
      almostWhy: {},
      eliteWhy: {},
      eliteExtraFail: {},
      obReason: {},
    },
  };
  if (!diags.length) return s;

  let sr = 0, sb = 0, sa = 0, se = 0;

  for (const d of diags) {
    const c = d?.counts || {};
    sr += n(c.radar, 0);
    sb += n(c.buildup, 0);
    sa += n(c.almost, 0);
    se += n(c.elite, 0);

    const r = d?.reasons || {};
    s.totals.radarOut = addCounts(s.totals.radarOut, r.radarOut);
    s.totals.buildupWhy = addCounts(s.totals.buildupWhy, r.buildupWhy);
    s.totals.almostWhy = addCounts(s.totals.almostWhy, r.almostWhy);
    s.totals.eliteWhy = addCounts(s.totals.eliteWhy, r.eliteWhy);
    s.totals.eliteExtraFail = addCounts(s.totals.eliteExtraFail, r.eliteExtraFail);
    s.totals.obReason = addCounts(s.totals.obReason, r.obReason);
  }

  const k = diags.length || 1;
  s.avg = {
    radar: +(sr / k).toFixed(2),
    buildup: +(sb / k).toFixed(2),
    almost: +(sa / k).toFixed(2),
    elite: +(se / k).toFixed(2),
  };
  return s;
}

// ===== Trade tuning (Moon) =====
function inferHitKind(pos, mode) {
  // we proberen netjes:
  const kind = String(pos?.exitKind || pos?.closeKind || pos?.kind || "").toUpperCase();
  if (kind === "SL" || kind === "TP" || kind === "TP1" || kind === "TP2" || kind === "TP3") return kind;

  const entry = n(pos?.entryPrice, 0);
  const last = n(pos?.exitPrice ?? pos?.priceNow ?? pos?.lastPrice, 0);
  const sl = n(pos?.sl, 0);
  const tp3 = n(pos?.tp3 ?? pos?.tp, 0);

  if (!(entry > 0 && last > 0)) return "CLOSED";

  if (mode === "bull") {
    if (sl > 0 && last <= sl) return "SL";
    if (tp3 > 0 && last >= tp3) return "TP";
  } else {
    if (sl > 0 && last >= sl) return "SL";
    if (tp3 > 0 && last <= tp3) return "TP";
  }
  return "CLOSED";
}

function summarizeMoonTrades(positions, mode) {
  const open = Array.isArray(positions?.open) ? positions.open : [];
  const closed = Array.isArray(positions?.closed) ? positions.closed : [];

  const outMap = {};
  let tpTooFar = 0;
  let slTooTight = 0;
  let haveMetrics = 0;

  for (const p of closed) {
    const k = inferHitKind(p, mode);
    outMap[k] = (outMap[k] || 0) + 1;

    // tuning met mfe/mae als die bestaat
    const mfe = Number.isFinite(Number(p?.mfePct)) ? n(p.mfePct, 0) : null;
    const mae = Number.isFinite(Number(p?.maePct)) ? n(p.maePct, 0) : null;
    if (mfe === null || mae === null) continue;

    const entry = n(p?.entryPrice, 0);
    const sl = n(p?.sl, 0);
    const tp = n(p?.tp3 ?? p?.tp, 0);
    if (!(entry > 0 && sl > 0 && tp > 0)) continue;
    haveMetrics++;

    const slPct = mode === "bull" ? ((entry - sl) / entry) * 100 : ((sl - entry) / entry) * 100;
    const tpPct = mode === "bull" ? ((tp - entry) / entry) * 100 : ((entry - tp) / entry) * 100;

    if (k === "SL") {
      const maeR = Math.abs(mae) / Math.max(0.0001, slPct);
      if (maeR <= 1.15) slTooTight++;
    } else if (k !== "TP") {
      const mfeRtp = Math.abs(mfe) / Math.max(0.0001, tpPct);
      if (mfeRtp >= 0.65 && mfeRtp <= 0.95) tpTooFar++;
    }
  }

  const tuning = [];
  if (haveMetrics >= 5) {
    if (slTooTight >= Math.ceil(haveMetrics * 0.35)) {
      tuning.push({
        title: "SL te strak (MOON)",
        now: "SL wordt vaak aangetikt en daarna loopt de coin alsnog door.",
        fix: [
          "Maak SL 25% wijder.",
          "In code: in /api/_moon_core.js → zoek computeMoonRisk → verhoog slMul basis (0.30 → 0.34) of maak clamp-min hoger.",
        ],
      });
    }
    if (tpTooFar >= Math.ceil(haveMetrics * 0.35)) {
      tuning.push({
        title: "TP te ver (MOON)",
        now: "Coins komen vaak dicht bij TP maar pakken hem net niet.",
        fix: [
          "Maak TP’s iets dichterbij (bijv. tp3 multiplier omlaag).",
          "Of: neem TP2 vaker als ‘main TP’ en TP3 als runner.",
        ],
      });
    }
  } else {
    tuning.push({
      title: "Nog te weinig moon trade-data voor harde tuning",
      now: "Je hebt te weinig CLOSED met mfePct/maePct.",
      fix: [
        "Laat je portfolio-engine mfePct/maePct vullen tijdens open pos.",
        "Pas daarna knoppen (slMul/tp multipliers) aan.",
      ],
    });
  }

  return {
    counts: { open: open.length, closed: closed.length, total: open.length + closed.length },
    outcomesTop: topN(outMap, 8),
    tuning,
    sampleClosed: closed.slice(-10),
  };
}

// “perfecte” suggesties = gebaseerd op grootste blokkade in diags (filters)
function filterSuggestions(sum) {
  const avgElite = n(sum?.avg?.elite, 0);
  const desiredMin = 3;
  const desiredMax = 10;

  const topEliteWhy = topN(sum?.totals?.eliteWhy, 5);
  const topExtraFail = topN(sum?.totals?.eliteExtraFail, 5);

  const out = {
    goal: `ELITE gemiddeld ${desiredMin}..${desiredMax} per scan`,
    now: `ELITE gemiddeld ${avgElite} per scan`,
    changes: {},
    reason: [],
  };

  const elite = MOON.elite;
  const roll = MOON.elite.roll;

  if (avgElite < desiredMin) {
    out.reason.push("Te weinig ELITE → versoepel 1 stapje bij grootste blokkade.");
    const mainBlock = String(topEliteWhy[0]?.key || "");
    const extraBlock = String(topExtraFail[0]?.key || "");

    if (mainBlock.toLowerCase().includes("confidence")) {
      out.changes["MOON.elite.minConfidence"] = `${elite.minConfidence} -> ${Math.max(0, elite.minConfidence - 3)}`;
    } else if (mainBlock.toLowerCase().includes("depth")) {
      out.changes["MOON.elite.depthMinUsd"] = `${elite.depthMinUsd} -> ${Math.max(0, Math.round(elite.depthMinUsd * 0.9))}`;
    } else if (extraBlock.toLowerCase().includes("vol") || extraBlock.toLowerCase().includes("dv")) {
      out.changes["MOON.elite.roll.minDeltaVol15m"] = `${roll.minDeltaVol15m} -> ${(roll.minDeltaVol15m * 0.8).toFixed(4)}`;
    } else {
      out.changes["MOON.elite.spreadMaxPct"] = `${elite.spreadMaxPct} -> ${(elite.spreadMaxPct + 0.1).toFixed(2)}`;
    }
  } else if (avgElite > desiredMax) {
    out.reason.push("Te veel ELITE → iets strenger zodat kwaliteit omhoog gaat.");
    out.changes["MOON.elite.minConfidence"] = `${elite.minConfidence} -> ${elite.minConfidence + 3}`;
  } else {
    out.reason.push("ELITE zit in de ‘gezonde’ zone → niets aanpassen.");
  }

  out.topBlocks = {
    eliteWhy: topEliteWhy,
    eliteExtraFail: topExtraFail,
    obReason: topN(sum?.totals?.obReason, 5),
    radarOut: topN(sum?.totals?.radarOut, 5),
  };

  return out;
}

function fmtDateMin(ts) {
  if (!ts) return "n/a";
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${da} ${h}:${mi}`;
}

// ===== nieuwe helpers voor copy-blok filteraanpassingen =====
function suggestedChangesText(sug) {
  const changes = sug?.changes || {};
  const keys = Object.keys(changes);
  if (!keys.length) return "// Geen changes voorgesteld (ELITE zit al goed).";

  // net formaat: 1 regel per wijziging
  return keys.map((k) => `${k} = ${changes[k]}`).join("\n");
}

function renderCopyChangesBlock(id, sug) {
  const txt = escapeHtml(suggestedChangesText(sug));
  return `
    <div class="box" style="grid-column: 1 / -1">
      <h3>Kopieer & plak — aanbevolen filter aanpassingen</h3>
      <div class="muted">Dit zijn de “suggested changes” uit de analyzer (kort en direct).</div>
      <textarea id="${id}" style="width:100%;min-height:120px;margin-top:8px;background:#071421;color:#e6edf3;border:1px solid #15334e;border-radius:10px;padding:10px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-size:12px;">${txt}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="copyText('${id}')" style="background:#111826;color:#e6edf3;border:1px solid #1f2a3a;border-radius:10px;padding:8px 10px;cursor:pointer">Copy</button>
      </div>
    </div>
  `;
}

// ===== TOEGEVOEGD: renderCopyBlock voor algemeen copy-blok =====
function renderCopyBlock(id, payload) {
  const txt = escapeHtml(String(payload || ""));
  return `
    <div class="box" style="grid-column: 1 / -1">
      <h3>Kopieer & plak — debug payload (ruw)</h3>
      <div class="muted">Handig als je wil dat ik exact mee kijk naar je data.</div>
      <textarea id="${id}" style="width:100%;min-height:220px;margin-top:8px;background:#071421;color:#e6edf3;border:1px solid #15334e;border-radius:10px;padding:10px;font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;font-size:12px;">${txt}</textarea>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
        <button onclick="copyText('${id}')" style="background:#111826;color:#e6edf3;border:1px solid #1f2a3a;border-radius:10px;padding:8px 10px;cursor:pointer">Copy</button>
      </div>
    </div>
  `;
}

// ===== buildCopyBlockMoon =====
function buildCopyBlockMoon({ mode, summary, suggestions, trades }) {
  const blocks = suggestions?.topBlocks || {};
  return {
    funnel: "moon",
    mode,
    ts: Date.now(),
    avgPerScan: summary?.avg || null,
    topBlocks: {
      eliteWhy: blocks.eliteWhy || [],
      eliteExtraFail: blocks.eliteExtraFail || [],
      obReason: blocks.obReason || [],
      radarOut: blocks.radarOut || [],
    },
    trades: {
      counts: trades?.counts || null,
      outcomesTop: trades?.outcomesTop || [],
    },

    // ✅ HUIDIGE instellingen (de waarheid)
    filtersNow: {
      universe: {
        CG_PER_PAGE: MOON.CG_PER_PAGE,
        CG_START_PAGE: MOON.CG_START_PAGE,
        CG_PAGES: MOON.CG_PAGES,
        RADAR_LIMIT: MOON.RADAR_LIMIT,
      },
      btcGate: {
        btcChgGate: MOON.btcChgGate,
        btcRangeMin: MOON.btcRangeMin,
        btcRangeMaxBull: MOON.btcRangeMaxBull,
        btcRangeMaxBear: MOON.btcRangeMaxBear,
      },
      caps: { mcapMin: MOON.mcapMin, mcapMax: MOON.mcapMax },
      radar: MOON.radar,
      buildup: MOON.buildup,
      almost: MOON.almost,
      elite: MOON.elite,
      riskWhere: {
        file: "/api/_moon_core.js",
        sltpFunc: "computeMoonRisk",
        hitFunc: "hitStopOrTp",
      },
    },

    // ✅ AANBEVOLEN changes (door analyzer bedacht)
    recommendedChanges: suggestions?.changes || {},
  };
}

function htmlPage(data) {
  const { long, short } = data;

  const card = (title, s, sug, tradeSum, portfolio, mode) => {
    const blocks = sug.topBlocks || {};
    const list = (arr) =>
      (arr || []).map((x) => `<li><b>${x.key}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";

    const changes = Object.entries(sug.changes || {})
      .map(([k, v]) => `<li><code>${k}</code>: <b>${v}</b></li>`)
      .join("") || "<li>n/a</li>";

    const outs = (tradeSum?.outcomesTop || [])
      .map((x) => `<li><b>${x.key}</b> — ${x.count}</li>`)
      .join("") || "<li>n/a</li>";

    const tune = (tradeSum?.tuning || [])
      .map((t) => `<div class="tune"><b>${t.title}</b><div class="muted">${t.now}</div><ul>${(t.fix || []).map((x) => `<li>${x}</li>`).join("")}</ul></div>`)
      .join("") || `<div class="muted">n/a</div>`;

    const copyId = `copy_${mode}`;
    // FIX: MOON.ob bestaat niet, vervangen door expliciete OB-velden uit MOON.elite
    const copyPayload = JSON.stringify(
      {
        filters: {
          elite: MOON.elite,
          eliteRoll: MOON.elite.roll,
          ob: {
            obScoreMin: MOON.elite.obScoreMin,
            spreadMaxPct: MOON.elite.spreadMaxPct,
            largestOrderRatioMax: MOON.elite.largestOrderRatioMax,
            samplesNeed: MOON.elite.samplesNeed,
            samplesWindowSec: MOON.elite.samplesWindowSec,
            minAgree: MOON.elite.minAgree,
            depthMinUsd: MOON.elite.depthMinUsd,
            depthMaxUsd: MOON.elite.depthMaxUsd,
            obSlopeEnabled: MOON.elite.obSlopeEnabled,
            obSlopeMinBull: MOON.elite.obSlopeMinBull,
            obSlopeMaxBear: MOON.elite.obSlopeMaxBear,
          },
        },
        summary: s,
        suggestions: sug,
        trades: tradeSum,
      },
      null,
      2
    );

    // Nieuw copy-blok met alle filters + top blokkades + recommended changes
    const copyBlock = buildCopyBlockMoon({ mode, summary: s, suggestions: sug, trades: tradeSum });
    const copyHtml = `
      <div class="box" style="margin-top:12px;grid-column:1/-1">
        <h3>📋 Copy/paste (MOON) — filters + blokkades + advies</h3>
        <div class="muted">Kopieer dit en plak het hier in de chat, dan kan ik exact zeggen wat je moet veranderen.</div>
        <textarea style="width:100%;height:260px;margin-top:8px;background:#0a1b2b;color:#e6edf3;border:1px solid #15334e;border-radius:10px;padding:10px;font-family:ui-monospace,Menlo,monospace;font-size:12px;">${escapeHtml(JSON.stringify(copyBlock, null, 2))}</textarea>
      </div>
    `;

    return `
      <div class="card">
        <h2>${title}</h2>
        <div class="muted">Laatste diag: <b>${fmtDateMin(s.lastTs)}</b> • scans: <b>${s.scans}</b></div>

        <div class="grid">
          <div class="box">
            <h3>Gemiddeld per scan</h3>
            <ul>
              <li>RADAR: <b>${s.avg.radar}</b></li>
              <li>BUILDUP: <b>${s.avg.buildup}</b></li>
              <li>ALMOST: <b>${s.avg.almost}</b></li>
              <li>ELITE: <b>${s.avg.elite}</b></li>
            </ul>
          </div>

          <div class="box">
            <h3>Filter-suggestie (coins → ELITE)</h3>
            <div class="muted">${sug.goal}<br/>${sug.now}</div>
            <ul>${changes}</ul>
            <div class="muted">${(sug.reason || []).join(" • ")}</div>
          </div>
        </div>

        <div class="grid">
          <div class="box">
            <h3>Top blokkades (ELITE)</h3>
            <ul>${list(blocks.eliteWhy)}</ul>
          </div>
          <div class="box">
            <h3>Top rolling fails</h3>
            <ul>${list(blocks.eliteExtraFail)}</ul>
          </div>
          <div class="box">
            <h3>Top OB reasons</h3>
            <ul>${list(blocks.obReason)}</ul>
          </div>
          <div class="box">
            <h3>Top RADAR out</h3>
            <ul>${list(blocks.radarOut)}</ul>
          </div>
        </div>

        <div class="grid">
          <div class="box">
            <h3>Trades (MOON) — status</h3>
            <div class="muted">Open: <b>${tradeSum?.counts?.open || 0}</b> • Closed: <b>${tradeSum?.counts?.closed || 0}</b></div>
            <ul>${outs}</ul>
          </div>

          <div class="box">
            <h3>Trades (MOON) — SL/TP tuning</h3>
            ${tune}
          </div>

          <div class="box">
            <h3>Portfolio (MOON)</h3>
            ${
              portfolio
                ? `<ul>
                    <li>posUsd: <b>${portfolio.posUsd}</b></li>
                    <li>openCount: <b>${portfolio.openCount}</b></li>
                    <li>closedCount: <b>${portfolio.closedCount}</b></li>
                    <li>realizedUsd: <b>${portfolio.realizedUsd}</b></li>
                    <li>avgRealizedPct: <b>${portfolio.avgRealizedPct}</b></li>
                    <li>updatedAt: <b>${fmtDateMin(portfolio.updatedAt)}</b></li>
                  </ul>`
                : `<div class="muted">n/a</div>`
            }
          </div>

          <div class="box">
            <h3>Waar SL/TP in code</h3>
            <ul>
              <li><code>/api/_moon_core.js</code> — zoek: <code>computeMoonRisk</code></li>
              <li><code>/api/_moon_core.js</code> — zoek: <code>hitStopOrTp</code></li>
            </ul>
          </div>
        </div>

        ${renderCopyChangesBlock(`copy_changes_${mode}`, sug)}
        ${renderCopyBlock(copyId, copyPayload)}
        ${copyHtml}  <!-- nieuw uitgebreid copy-blok -->
      </div>
    `;
  };

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>MOON Analyze+</title>
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
    code{background:#0a1b2b;border:1px solid #15334e;padding:2px 6px;border-radius:8px}
    .tune{margin-top:8px;padding:8px;border:1px solid #15334e;border-radius:10px;background:#0a1b2b}
  </style>
  <!-- TOEGEVOEGD: copyText functie -->
  <script>
    function copyText(id){
      const el = document.getElementById(id);
      if(!el) return alert("Copy blok niet gevonden");
      el.select();
      el.setSelectionRange(0, 999999);
      try {
        document.execCommand("copy");
        alert("Gekopieerd ✅");
      } catch(e){
        navigator.clipboard?.writeText(el.value || el.textContent || "");
        alert("Gekopieerd ✅");
      }
    }
  </script>
</head>
<body>
  <div class="wrap">
    <h1>MOON Analyze+ (LONG vs SHORT) + Trades tuning</h1>
    <div class="row">
      ${long ? card("LONG (bull)", long.summary, long.suggestions, long.trades, long.portfolio, "bull") : ""}
      ${short ? card("SHORT (bear)", short.summary, short.suggestions, short.trades, short.portfolio, "bear") : ""}
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
    if (!requireSecret(req, res)) return;

    const mode = normalizeMode(req.query?.mode);
    const format = String(req.query?.format || "html").toLowerCase();
    const limit = Math.max(1, Math.min(200, parseInt(String(req.query?.limit || "30"), 10) || 30));

    const make = async (m) => {
      const diags = await readDiags(m, limit);
      const summary = summarizeDiags(diags);
      const positions = await readPositions(m);
      const portfolio = await readPortfolio(m);
      const trades = summarizeMoonTrades(positions, m);
      return { summary, suggestions: filterSuggestions(summary), diags, trades, portfolio };
    };

    const data =
      mode === "all"
        ? { long: await make("bull"), short: await make("bear") }
        : mode === "bull"
          ? { long: await make("bull") }
          : { short: await make("bear") };

    if (format === "json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ ok: true, mode, limit, data }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(htmlPage(data));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}
