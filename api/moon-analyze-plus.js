// api/moon-analyze-plus.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  MOON,
  keyMoonDiagList,
  keyMoonDiagSnap,
} from "./_moon_core.js";

export const config = RUNTIME_CONFIG;

// ===== helpers =====
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

function summarize(diags) {
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

// “perfecte” suggesties = klein en gebaseerd op jouw grootste blokkade
function suggestions(sum) {
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

  // Huidige instellingen (we tonen ze ook)
  const elite = MOON.elite;
  const roll = MOON.elite.roll;

  if (avgElite < desiredMin) {
    out.reason.push("Te weinig ELITE → versoepel 1 stapje bij grootste blokkade.");
    const mainBlock = String(topEliteWhy[0]?.key || "");
    const extraBlock = String(topExtraFail[0]?.key || "");

    // 1) Confidence net iets omlaag
    if (mainBlock.toLowerCase().includes("confidence")) {
      out.changes["MOON.elite.minConfidence"] = `${elite.minConfidence} -> ${Math.max(0, elite.minConfidence - 3)}`;
    }
    // 2) Depth floor net iets omlaag
    else if (mainBlock.toLowerCase().includes("depth")) {
      out.changes["MOON.elite.depthMinUsd"] = `${elite.depthMinUsd} -> ${Math.max(0, Math.round(elite.depthMinUsd * 0.9))}`;
    }
    // 3) Rolling: ΔV te streng? verlaag minDeltaVol15m een tikje
    else if (extraBlock.toLowerCase().includes("Δv") || extraBlock.toLowerCase().includes("dv") || extraBlock.toLowerCase().includes("vol")) {
      out.changes["MOON.elite.roll.minDeltaVol15m"] = `${roll.minDeltaVol15m} -> ${(roll.minDeltaVol15m * 0.8).toFixed(4)}`;
    }
    // fallback: spread iets ruimer
    else {
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
  // afronden op minuten (geen seconden)
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${da} ${h}:${mi}`;
}

function htmlPage(data) {
  const { long, short } = data;

  const card = (title, s, sug) => {
    const blocks = sug.topBlocks || {};
    const list = (arr) =>
      (arr || []).map((x) => `<li><b>${x.key}</b> — ${x.count}</li>`).join("") || "<li>n/a</li>";

    const changes = Object.entries(sug.changes || {})
      .map(([k, v]) => `<li><code>${k}</code>: <b>${v}</b></li>`)
      .join("") || "<li>n/a</li>";

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
            <h3>Suggestie</h3>
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
  </style>
</head>
<body>
  <div class="wrap">
    <h1>MOON Analyze+ (LONG vs SHORT)</h1>
    <div class="row">
      ${card("LONG (bull)", long.summary, long.suggestions)}
      ${card("SHORT (bear)", short.summary, short.suggestions)}
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
      const summary = summarize(diags);
      return { summary, suggestions: suggestions(summary), diags };
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
    return res.end(htmlPage(data.ok ? data : data));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}