// /api/analyze-main.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  requireSecret,
  keyLatest,
  keyDiagList,
  keyDiagSnap,
} from "./_core.js";
import { readEvents, readTrades } from "./_analytics.js";

export const config = RUNTIME_CONFIG;

function fmtDateMin(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "-";
  // NL stijl, zonder seconden
  return d.toLocaleString("nl-NL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pct(n) {
  const x = Number(n || 0);
  return `${(x * 100).toFixed(0)}%`;
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function getLast(arr) {
  const a = safeArr(arr);
  return a.length ? a[a.length - 1] : null;
}

async function readLatestDiag(mode) {
  try {
    // Prefer list history (newest at index 0 because lpush)
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyDiagList(mode), 0, 0);
      const one = safeArr(raw)[0];
      if (!one) return null;
      return typeof one === "string" ? JSON.parse(one) : one;
    }
  } catch {}
  try {
    const snap = await kv.get(keyDiagSnap(mode));
    return snap || null;
  } catch {
    return null;
  }
}

function suggestFromDiag(diag, modeLabel) {
  if (!diag) {
    return [
      `Geen diagnose gevonden voor ${modeLabel}. Tip: run eerst /api/scan?mode=... zodat diag wordt opgeslagen.`,
    ];
  }

  const s = diag.settings || {};
  const counts = diag.counts || {};
  const reasons = diag.reasons || {};
  const entryGate = reasons.entryGate || {};
  const obReason = reasons.obReason || {};

  const sug = [];

  // 1) Te weinig RADAR -> filters te streng
  if ((counts.radar || 0) < 10) {
    sug.push(
      `Weinig coins in RADAR (${counts.radar || 0}). Maak RADAR iets ruimer: verlaag vmMinRadar of volMinRadar, of verhoog mcapMax.`
    );
  }

  // 2) Veel RADAR maar bijna geen BUILDUP/ALMOST -> buildup/almost te streng of consistency te streng
  if ((counts.radar || 0) > 80 && (counts.buildup || 0) < 5) {
    sug.push(
      `Veel RADAR maar bijna geen BUILDUP. Tip: verlaag BUILDUP eisen (buildup.vmMin / buildup.volMin) of maak consistencyMinRatio iets lager.`
    );
  }

  if ((counts.buildup || 0) > 20 && (counts.almost || 0) === 0) {
    sug.push(
      `Wel BUILDUP maar geen ALMOST. Tip: ALMOST is te streng (volMin / vmMin / priceFlatMax). Maak priceFlatMax iets hoger.`
    );
  }

  // 3) ENTRY block redenen (meest voorkomende)
  const topEntryBlock = Object.entries(entryGate)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 2);

  if (topEntryBlock.length) {
    const [r1, r2] = topEntryBlock;
    sug.push(
      `Top ENTRY blokkade: "${r1[0]}" (${r1[1]}x)` + (r2 ? `, daarna "${r2[0]}" (${r2[1]}x).` : ".")
    );
  }

  // 4) OB issues (validating / not enough / stale)
  const topOb = Object.entries(obReason)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, 2);

  if (topOb.length) {
    const [o1, o2] = topOb;
    sug.push(
      `Top orderbook-reden: "${o1[0]}" (${o1[1]}x)` + (o2 ? `, daarna "${o2[0]}" (${o2[1]}x).` : ".")
    );
    sug.push(
      `Als "Not enough samples" vaak voorkomt: verhoog samplesWindowSec of verlaag samplesNeed (maar liever window groter, dat is netter).`
    );
  }

  // 5) Universe drop (CG -> Bitget -> Radar)
  const uni = diag.universe || {};
  if ((uni.cgTotal || 0) > 0) {
    const a = uni.afterSymbols || uni.afterBitget || 0;
    const b = uni.afterRadar || 0;
    if (a > 0 && b / a < 0.25) {
      sug.push(
        `Veel coins vallen af bij RADAR (afterRadar is laag). Dat betekent: jouw RADAR filters zijn streng t.o.v. jouw universe.`
      );
    }
  }

  // 6) Concrete hint per mode
  if (String(diag.btc?.state || "").toUpperCase() === "NEUTRAL") {
    sug.push(
      `BTC is NEUTRAL. Dat is oké met jouw SOFT-open setup. Wil je minder ruis? Dan kun je NEUTRAL alsnog blokkeren voor ${modeLabel}.`
    );
  }

  if (!sug.length) {
    sug.push(`Ziet er gezond uit. Eerst meer data verzamelen (meer scans), daarna pas thresholds tweaken.`);
  }

  return sug;
}

function htmlPage({ tokenPresent, long, short, diagLong, diagShort, sugLong, sugShort, trades, events }) {
  const css = `
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto; margin:18px; color:#111;}
    .wrap{max-width:1100px;margin:0 auto;}
    h1{font-size:20px;margin:0 0 10px;}
    .muted{color:#666;font-size:13px;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:14px;}
    .card{border:1px solid #e6e6e6;border-radius:12px;padding:12px;}
    .row{display:flex;gap:10px;flex-wrap:wrap}
    .pill{background:#f4f4f4;border-radius:999px;padding:6px 10px;font-size:13px;}
    table{width:100%;border-collapse:collapse;margin-top:10px;}
    th,td{border-bottom:1px solid #eee;padding:8px 6px;text-align:left;font-size:13px;}
    th{background:#fafafa;}
    ul{margin:8px 0 0 18px;}
    code{background:#f6f6f6;padding:2px 6px;border-radius:6px;}
  `;

  const longTs = long?.ts ? fmtDateMin(long.ts) : "-";
  const shortTs = short?.ts ? fmtDateMin(short.ts) : "-";

  const longCounts = long?.counts || long?.funnel?.counts || long?.counts || {};
  const shortCounts = short?.counts || short?.funnel?.counts || short?.counts || {};

  const openTrades = safeArr(trades).filter(t => String(t?.status) === "OPEN");
  const closedTrades = safeArr(trades).filter(t => String(t?.status) === "CLOSED");

  const lastEv = getLast(events);

  return `<!doctype html>
  <html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Analyze MAIN</title><style>${css}</style></head>
  <body><div class="wrap">
    <h1>Analyze MAIN (LONG vs SHORT)</h1>
    <div class="muted">
      Token: ${tokenPresent ? "ok" : "niet meegestuurd / niet nodig"} •
      Laatste event: ${lastEv?.ts ? fmtDateMin(lastEv.ts) : "-"} •
      Trades open: ${openTrades.length} • Trades closed: ${closedTrades.length}
    </div>

    <div class="grid">
      <div class="card">
        <div class="row">
          <div class="pill"><b>LONG</b> (was: bull)</div>
          <div class="pill">scan: ${longTs}</div>
          <div class="pill">BTC: ${String(long?.btc?.state || "-")}</div>
        </div>
        <table>
          <tr><th>Funnel</th><th>Aantal</th></tr>
          <tr><td>ENTRY</td><td>${longCounts.entry ?? long?.funnel?.entry?.length ?? 0}</td></tr>
          <tr><td>ALMOST</td><td>${longCounts.almost ?? long?.funnel?.almost?.length ?? 0}</td></tr>
          <tr><td>BUILDUP</td><td>${longCounts.buildup ?? long?.funnel?.buildup?.length ?? 0}</td></tr>
          <tr><td>RADAR</td><td>${longCounts.radar ?? long?.funnel?.radar?.length ?? 0}</td></tr>
        </table>

        <div style="margin-top:10px"><b>Suggesties (LONG)</b></div>
        <ul>${sugLong.map(x => `<li>${x}</li>`).join("")}</ul>

        <div style="margin-top:10px" class="muted">
          Diagnose ts: ${diagLong?.ts ? fmtDateMin(diagLong.ts) : "-"}
        </div>
      </div>

      <div class="card">
        <div class="row">
          <div class="pill"><b>SHORT</b> (was: bear)</div>
          <div class="pill">scan: ${shortTs}</div>
          <div class="pill">BTC: ${String(short?.btc?.state || "-")}</div>
        </div>
        <table>
          <tr><th>Funnel</th><th>Aantal</th></tr>
          <tr><td>ENTRY</td><td>${shortCounts.entry ?? short?.funnel?.entry?.length ?? 0}</td></tr>
          <tr><td>ALMOST</td><td>${shortCounts.almost ?? short?.funnel?.almost?.length ?? 0}</td></tr>
          <tr><td>BUILDUP</td><td>${shortCounts.buildup ?? short?.funnel?.buildup?.length ?? 0}</td></tr>
          <tr><td>RADAR</td><td>${shortCounts.radar ?? short?.funnel?.radar?.length ?? 0}</td></tr>
        </table>

        <div style="margin-top:10px"><b>Suggesties (SHORT)</b></div>
        <ul>${sugShort.map(x => `<li>${x}</li>`).join("")}</ul>

        <div style="margin-top:10px" class="muted">
          Diagnose ts: ${diagShort?.ts ? fmtDateMin(diagShort.ts) : "-"}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <b>Test links</b>
      <div class="muted" style="margin-top:6px">
        1) Eerst scan draaien zodat analyze data heeft:
        <div><code>/api/scan?mode=bull&token=JOUW_TOKEN</code></div>
        <div><code>/api/scan?mode=bear&token=JOUW_TOKEN</code></div>
        <br/>
        2) Dan analyze openen:
        <div><code>/api/analyze-main?format=html&token=JOUW_TOKEN</code></div>
        <div><code>/api/analyze-main?token=JOUW_TOKEN</code> (JSON)</div>
      </div>
    </div>

  </div></body></html>`;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const format = String(req.query?.format || "html").toLowerCase();
    const tokenPresent = !!req.query?.token;

    // latest scan snapshots
    const long = await kv.get(keyLatest("bull"));
    const short = await kv.get(keyLatest("bear"));

    // last diag snapshots
    const diagLong = await readLatestDiag("bull");
    const diagShort = await readLatestDiag("bear");

    // suggestions
    const sugLong = suggestFromDiag(diagLong, "LONG");
    const sugShort = suggestFromDiag(diagShort, "SHORT");

    // analytics (events + trades)
    const trades = await readTrades("main");
    const events = await readEvents("main", 2000);

    if (format === "html") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(
        htmlPage({ tokenPresent, long, short, diagLong, diagShort, sugLong, sugShort, trades, events })
      );
    }

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(
      JSON.stringify({
        ok: true,
        ts: Date.now(),
        view: "analyze-main",
        naming: { bull: "LONG", bear: "SHORT" },
        latest: { long, short },
        diag: { long: diagLong, short: diagShort },
        suggestions: { long: sugLong, short: sugShort },
        analytics: {
          tradesCount: safeArr(trades).length,
          eventsCount: safeArr(events).length,
        },
      })
    );
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}