// /api/analyze-main.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// ===== Secret check (zelfde idee als requireSecret) =====
// Zet in Vercel env: CC_TOKEN = jouw token (cc_...)
// (Als je al een andere naam gebruikt, zet CC_TOKEN er óók bij, dat is het makkelijkst.)
function requireSecret(req, res) {
  const got = String(req.query?.token || req.headers?.["x-token"] || "");
  const want =
    String(process.env.CC_TOKEN || process.env.SECRET_TOKEN || process.env.ADMIN_TOKEN || "");

  if (!want) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Server missing CC_TOKEN env var" }));
    return false;
  }
  if (!got || got !== want) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

// ===== Keys (matcht wat 99% scanners doen) =====
const keyLatest = (mode) => `latest:${String(mode || "bull")}`;
const keyDiagList = (mode) => `diag:list:${String(mode || "bull")}`;
const keyDiagSnap = (mode) => `diag:snap:${String(mode || "bull")}`;
const keyTrades = (funnel) => `trades:${String(funnel || "main")}`;
const keyEvents = (funnel) => `events:${String(funnel || "main")}`;

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function fmtDateMin(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "-";
  return d.toLocaleString("nl-NL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function readLatestDiag(mode) {
  try {
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

async function readTrades(funnel) {
  try {
    return safeArr(await kv.get(keyTrades(funnel)));
  } catch {
    return [];
  }
}

async function readEvents(funnel, max = 2000) {
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyEvents(funnel), 0, Math.min(max, 40000) - 1);
      return safeArr(raw)
        .map((x) => {
          try {
            return typeof x === "string" ? JSON.parse(x) : x;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
  } catch {}
  return [];
}

function top2(mapObj) {
  const e = Object.entries(mapObj || {});
  e.sort((a, b) => (b[1] || 0) - (a[1] || 0));
  return e.slice(0, 2);
}

function suggestFromDiag(diag, modeLabel) {
  if (!diag) {
    return [
      `Geen diagnose gevonden voor ${modeLabel}. Draai eerst /api/scan?mode=... zodat diag wordt opgeslagen.`,
    ];
  }

  const counts = diag.counts || {};
  const reasons = diag.reasons || {};
  const entryGate = reasons.entryGate || {};
  const obReason = reasons.obReason || {};
  const uni = diag.universe || {};

  const sug = [];

  if ((counts.radar || 0) < 10) {
    sug.push(
      `Weinig coins in RADAR (${counts.radar || 0}). Maak RADAR ruimer (vmMinRadar of volMinRadar omlaag).`
    );
  }

  if ((counts.radar || 0) > 80 && (counts.buildup || 0) < 5) {
    sug.push(
      `Veel RADAR maar bijna geen BUILDUP. Maak BUILDUP ruimer (buildup.vmMin / buildup.volMin omlaag).`
    );
  }

  if ((counts.buildup || 0) > 20 && (counts.almost || 0) === 0) {
    sug.push(
      `Wel BUILDUP maar geen ALMOST. Maak ALMOST ruimer (priceFlatMax iets hoger of volMin/vmMin omlaag).`
    );
  }

  const te = top2(entryGate);
  if (te.length) {
    const [a, b] = te;
    sug.push(
      `Top ENTRY blokkade: "${a[0]}" (${a[1]}x)` + (b ? `, daarna "${b[0]}" (${b[1]}x).` : ".")
    );
  }

  const to = top2(obReason);
  if (to.length) {
    const [a, b] = to;
    sug.push(
      `Top orderbook-reden: "${a[0]}" (${a[1]}x)` + (b ? `, daarna "${b[0]}" (${b[1]}x).` : ".")
    );
    sug.push(`Als "Not enough samples" vaak voorkomt: maak samplesWindowSec groter.`);
  }

  const afterUni = uni.afterSymbols || uni.afterBitget || 0;
  const afterRadar = uni.afterRadar || 0;
  if (afterUni > 0 && afterRadar / afterUni < 0.25) {
    sug.push(`Veel coins vallen af bij RADAR. RADAR filters zijn streng t.o.v. jouw universe.`);
  }

  if (String(diag?.btc?.state || "").toUpperCase() === "NEUTRAL") {
    sug.push(`BTC is NEUTRAL. Wil je minder ruis? Dan kun je NEUTRAL blokkeren voor ${modeLabel}.`);
  }

  if (!sug.length) sug.push(`Ziet er gezond uit. Eerst meer scans draaien, daarna pas tweaken.`);
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

  const openTrades = safeArr(trades).filter((t) => String(t?.status) === "OPEN");
  const lastEv = safeArr(events).slice(-1)[0] || null;

  const longCounts = long?.counts || {};
  const shortCounts = short?.counts || {};

  return `<!doctype html>
  <html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Analyze MAIN</title><style>${css}</style></head>
  <body><div class="wrap">
    <h1>Analyze MAIN (LONG vs SHORT)</h1>
    <div class="muted">
      Token: ${tokenPresent ? "ok" : "niet meegestuurd"} •
      Laatste event: ${lastEv?.ts ? fmtDateMin(lastEv.ts) : "-"} •
      Trades open: ${openTrades.length}
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
        <ul>${sugLong.map((x) => `<li>${x}</li>`).join("")}</ul>
        <div style="margin-top:10px" class="muted">Diagnose ts: ${diagLong?.ts ? fmtDateMin(diagLong.ts) : "-"}</div>
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
        <ul>${sugShort.map((x) => `<li>${x}</li>`).join("")}</ul>
        <div style="margin-top:10px" class="muted">Diagnose ts: ${diagShort?.ts ? fmtDateMin(diagShort.ts) : "-"}</div>
      </div>
    </div>

    <div class="card" style="margin-top:14px">
      <b>Test links</b>
      <div class="muted" style="margin-top:6px">
        1) Eerst scan draaien:
        <div><code>/api/scan?mode=bull&token=JOUW_TOKEN</code></div>
        <div><code>/api/scan?mode=bear&token=JOUW_TOKEN</code></div>
        <br/>
        2) Daarna analyze:
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

    const long = await kv.get(keyLatest("bull"));
    const short = await kv.get(keyLatest("bear"));

    const diagLong = await readLatestDiag("bull");
    const diagShort = await readLatestDiag("bear");

    const sugLong = suggestFromDiag(diagLong, "LONG");
    const sugShort = suggestFromDiag(diagShort, "SHORT");

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