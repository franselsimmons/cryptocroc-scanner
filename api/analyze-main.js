// /api/analyze-main.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// ======================================================
// SECRET CHECK  (werkt met CRON_SECRET of CC_TOKEN)
// ======================================================
function requireSecret(req, res) {
  const got = String(req.query?.token || req.headers?.["x-token"] || "");
  const want = String(
    process.env.CRON_SECRET ||
      process.env.CC_TOKEN ||
      process.env.SECRET_TOKEN ||
      process.env.ADMIN_TOKEN ||
      ""
  );

  if (!want) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        ok: false,
        error: "Server missing token env var (CRON_SECRET / CC_TOKEN)",
      })
    );
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

// ======================================================
// KV KEYS
// ======================================================
const keyLatest = (mode) => `latest:${String(mode || "bull")}`;
const keyTrades = (funnel) => `trades:${String(funnel || "main")}`;
const keyEvents = (funnel) => `events:${String(funnel || "main")}`;

// ======================================================
// HELPERS
// ======================================================
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
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
function pct(x, digits = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return `${v.toFixed(digits)}%`;
}
function money(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}
function inc(map, key) {
  const k = String(key || "Unknown");
  map[k] = (map[k] || 0) + 1;
  return map;
}
function topN(map, k = 6) {
  const arr = Object.entries(map || {}).map(([key, count]) => ({ key, count }));
  arr.sort((a, b) => b.count - a.count);
  return arr.slice(0, k);
}

// ======================================================
// DATA READ
// ======================================================
async function readTrades(funnel) {
  try {
    return safeArr(await kv.get(keyTrades(funnel)));
  } catch {
    return [];
  }
}

async function readEvents(funnel, max = 500) {
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyEvents(funnel), 0, Math.max(0, max - 1));
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

// ======================================================
// “WAT BLOKKEERT MIJ?” ANALYSE UIT JOUW LATEST DATA
// We gebruiken jouw coin velden:
// - coin.why.entryGate
// - coin.ob.reason
// - coin.ob.status / valid
// ======================================================
function flattenCoins(latest) {
  const f = latest?.funnel || {};
  const all = [
    ...safeArr(f.entry).map((c) => ({ ...c, _stage: "ENTRY" })),
    ...safeArr(f.almost).map((c) => ({ ...c, _stage: "ALMOST" })),
    ...safeArr(f.buildup).map((c) => ({ ...c, _stage: "BUILDUP" })),
    ...safeArr(f.radar).map((c) => ({ ...c, _stage: "RADAR" })),
  ];
  return all;
}

function summarizeSide(latest, label) {
  const coins = flattenCoins(latest);

  const gateMap = {};
  const obReasonMap = {};
  const obStatusMap = {};
  const stageMap = { ENTRY: 0, ALMOST: 0, BUILDUP: 0, RADAR: 0 };

  for (const c of coins) {
    stageMap[String(c?._stage || "RADAR")] =
      (stageMap[String(c?._stage || "RADAR")] || 0) + 1;

    const gate = c?.why?.entryGate || "";
    if (gate) inc(gateMap, gate);

    const obStatus = c?.ob?.status || "";
    if (obStatus) inc(obStatusMap, obStatus);

    const obReason = c?.ob?.reason || "";
    if (obReason) inc(obReasonMap, obReason);
  }

  // “Actie” suggesties (simpel & eerlijk)
  const suggestions = [];

  const btcState = String(latest?.btc?.state || "").toUpperCase();
  if (label === "LONG" && btcState === "BEAR") {
    suggestions.push({
      title: "BTC staat BEAR maar je draait LONG",
      what: "Dan blokkeert je systeem meestal (of je krijgt alleen RADAR).",
      fix: [
        "Optie A: draai SHORT scan als BTC BEAR is.",
        "Optie B: maak je BTC-gate minder streng (NEUTRAL/BEAR toelaten voor LONG).",
      ],
      where: [
        { file: "/api/scan.js", search: "btc" },
        { file: "/api/_core.js", search: "BTC" },
      ],
    });
  }

  const tGate = topN(gateMap, 3);
  const tObReason = topN(obReasonMap, 3);
  const tObStatus = topN(obStatusMap, 3);

  // Veel “OB validating” = sampler duurt te kort / te streng
  if (gateMap["OB validating"] >= 3 || obStatusMap["validating"] >= 3) {
    suggestions.push({
      title: "Veel coins blijven hangen op ‘OB validating’",
      what: "Je orderbook meting heeft te weinig samples of te korte tijd.",
      fix: [
        "Maak de sample-window langer (bijv. 45s → 90s).",
        "Of verlaag ‘samplesNeed’ een klein beetje.",
      ],
      where: [
        { file: "/api/ob-sampler.js", search: "samplesWindowSec" },
        { file: "/api/ob-sampler.js", search: "samplesNeed" },
      ],
    });
  }

  // “Direction not consistent”
  if (obReasonMap["Direction not consistent"] >= 3) {
    suggestions.push({
      title: "‘Direction not consistent’ komt vaak voor",
      what: "Je systeem wil bevestiging dat de orderbook-kant (bid/ask) hetzelfde blijft. Nu wisselt het te vaak.",
      fix: [
        "Maak ‘agree’ eis iets lager (bijv. 3 → 2).",
        "Of maak de check minder streng (meer tolerantie op slope/lor).",
      ],
      where: [
        { file: "/api/orderbook.js", search: "Direction not consistent" },
        { file: "/api/ob-sampler.js", search: "agree" },
        { file: "/api/orderbook.js", search: "lor" },
      ],
    });
  }

  // “Depth too thin”
  const depthGates = Object.keys(gateMap).filter((k) =>
    k.toLowerCase().includes("depth too thin")
  );
  if (depthGates.length) {
    suggestions.push({
      title: "‘Depth too thin’ blokkeert entry",
      what: "Je minimum orderbook diepte (USD) staat te hoog voor jouw coins.",
      fix: [
        "Verlaag de depthMinUsd1p drempel (bijv. 60000 → 30000).",
        "Of maak depth afhankelijk van marketcap (kleinere coins lagere drempel).",
      ],
      where: [
        { file: "/api/orderbook.js", search: "depthMinUsd1p" },
        { file: "/api/orderbook.js", search: "Depth too thin" },
      ],
    });
  }

  // Als er alleen RADAR is
  if ((stageMap.ENTRY || 0) === 0 && (stageMap.ALMOST || 0) === 0 && (stageMap.BUILDUP || 0) === 0) {
    suggestions.push({
      title: "Alles blijft in RADAR (geen BUILDUP/ALMOST/ENTRY)",
      what: "Dan is je doorgang (RADAR→BUILDUP→ALMOST→ENTRY) te streng.",
      fix: [
        "Maak BUILDUP criteria iets ruimer (vmMin/volMin).",
        "Maak ALMOST criteria iets ruimer (priceFlatMax / momentum).",
      ],
      where: [
        { file: "/api/scan.js", search: "buildup" },
        { file: "/api/scan.js", search: "almost" },
        { file: "/api/scan.js", search: "vmMin" },
        { file: "/api/scan.js", search: "volMin" },
      ],
    });
  }

  return {
    btcState,
    stageMap,
    topGate: tGate,
    topObReason: tObReason,
    topObStatus: tObStatus,
    suggestions,
    coins,
  };
}

// ======================================================
// HTML UI
// ======================================================
function pill(text, cls = "") {
  return `<span class="pill ${cls}">${text}</span>`;
}

function renderTopList(title, items) {
  const li =
    (items || []).map((x) => `<li><b>${x.key}</b> <span class="muted">(${x.count}x)</span></li>`).join("") ||
    `<li class="muted">n/a</li>`;
  return `
    <div class="box">
      <div class="boxtitle">${title}</div>
      <ul class="list">${li}</ul>
    </div>
  `;
}

function renderSuggestions(sugs) {
  if (!sugs?.length) return `<div class="muted">Geen duidelijke actie gevonden. Draai meer scans.</div>`;

  return sugs
    .map((s) => {
      const fixes = (s.fix || []).map((x) => `<li>${x}</li>`).join("");
      const where = (s.where || [])
        .map((w) => `<li><code>${w.file}</code> — zoek: <code>${w.search}</code></li>`)
        .join("");

      return `
        <div class="suggest">
          <div class="suggestTitle">${s.title}</div>
          <div class="muted">${s.what}</div>
          <div class="suggestGrid">
            <div>
              <div class="miniTitle">Wat aanpassen</div>
              <ul class="list">${fixes || `<li class="muted">n/a</li>`}</ul>
            </div>
            <div>
              <div class="miniTitle">Waar in GitHub</div>
              <ul class="list">${where || `<li class="muted">n/a</li>`}</ul>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderCoinsTable(coins, limit = 25) {
  const rows = safeArr(coins)
    .slice(0, limit)
    .map((c) => {
      const ob = c?.ob || {};
      const why = c?.why || {};
      return `
        <tr>
          <td><b>${String(c?.symbol || "-")}</b> <span class="muted">${String(c?.name || "")}</span></td>
          <td>${String(c?._stage || "-")}</td>
          <td>${n(c?.price, 0) ? `$${n(c?.price, 0)}` : "-"}</td>
          <td>${pct(c?.change24, 2)}</td>
          <td>${n(c?.vm, 0).toFixed(3)}</td>
          <td>${ob?.valid ? pill("valid", "ok") : pill(String(ob?.status || "n/a"), "warn")}</td>
          <td>${String(ob?.reason || "-")}</td>
          <td>${String(why?.entryGate || "-")}</td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="box" style="margin-top:12px">
      <div class="boxtitle">Coins (eerste ${limit})</div>
      <div class="muted" style="margin-bottom:8px">
        Tip: als bijna alles “OB validating / Direction not consistent” is → orderbook regels zijn de bottleneck.
      </div>
      <div class="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Coin</th>
              <th>Stage</th>
              <th>Price</th>
              <th>24h</th>
              <th>VM</th>
              <th>OB</th>
              <th>OB reason</th>
              <th>Gate</th>
            </tr>
          </thead>
          <tbody>${rows || ""}</tbody>
        </table>
      </div>
    </div>
  `;
}

function htmlPage({ tokenPresent, longLatest, shortLatest, trades, events }) {
  const css = `
    :root{
      --bg:#0b0f14; --card:#111826; --box:#0c1320; --line:#1f2a3a;
      --text:#e6edf3; --muted:#9fb0c3; --ok:#19c37d; --warn:#f6c177;
      --bad:#ff6b6b;
    }
    *{box-sizing:border-box}
    body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto}
    .wrap{max-width:1180px;margin:0 auto;padding:18px}
    h1{margin:0 0 10px 0;font-size:20px}
    .topline{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px}
    .pill{display:inline-flex;gap:6px;align-items:center;background:#0a1b2b;border:1px solid #15334e;padding:6px 10px;border-radius:999px;font-size:13px;color:var(--text)}
    .pill.ok{border-color:rgba(25,195,125,.5)}
    .pill.warn{border-color:rgba(246,193,119,.6)}
    .pill.bad{border-color:rgba(255,107,107,.6)}
    .muted{color:var(--muted);font-size:13px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px;min-width:320px}
    .head{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:10px}
    .title{font-size:16px;font-weight:700}
    .mini{font-size:12px;color:var(--muted)}
    .kpis{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
    .kpi{background:var(--box);border:1px solid var(--line);border-radius:12px;padding:10px;min-width:120px}
    .kpi b{font-size:18px}
    .boxes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:12px}
    .box{background:var(--box);border:1px solid var(--line);border-radius:12px;padding:10px}
    .boxtitle{font-size:13px;font-weight:700;margin-bottom:6px}
    ul.list{margin:0;padding-left:18px}
    .suggest{background:#0a1b2b;border:1px solid #15334e;border-radius:12px;padding:10px;margin-top:10px}
    .suggestTitle{font-weight:800;margin-bottom:4px}
    .miniTitle{font-weight:700;margin:8px 0 4px 0;font-size:13px}
    .suggestGrid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
    code{background:#071421;border:1px solid #15334e;padding:2px 6px;border-radius:8px}
    .tablewrap{overflow:auto;border-radius:12px;border:1px solid var(--line)}
    table{width:100%;border-collapse:collapse;min-width:920px;background:transparent}
    th,td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left;font-size:13px;vertical-align:top}
    th{position:sticky;top:0;background:rgba(17,24,38,.95)}
    .footer{margin-top:12px}
    .btnrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px}
    a.link{color:var(--text);text-decoration:none;border:1px solid var(--line);padding:8px 10px;border-radius:10px;background:var(--card)}
    a.link:hover{border-color:#2a3b55}
    @media (max-width: 980px){
      .grid{grid-template-columns:1fr}
      .boxes{grid-template-columns:1fr}
      .suggestGrid{grid-template-columns:1fr}
    }
  `;

  const longTs = longLatest?.ts ? fmtDateMin(longLatest.ts) : "-";
  const shortTs = shortLatest?.ts ? fmtDateMin(shortLatest.ts) : "-";

  const longSum = summarizeSide(longLatest, "LONG");
  const shortSum = summarizeSide(shortLatest, "SHORT");

  const openTrades = safeArr(trades).filter((t) => String(t?.status) === "OPEN");
  const lastEv = safeArr(events).slice(-1)[0] || null;

  const badge = (state) => {
    const s = String(state || "").toUpperCase();
    if (s === "BULL") return pill("BTC: BULL", "ok");
    if (s === "BEAR") return pill("BTC: BEAR", "bad");
    if (s) return pill(`BTC: ${s}`, "warn");
    return pill("BTC: -", "warn");
  };

  const kpiRow = (stageMap) => `
    <div class="kpis">
      <div class="kpi"><div class="mini">RADAR</div><b>${stageMap.RADAR || 0}</b></div>
      <div class="kpi"><div class="mini">BUILDUP</div><b>${stageMap.BUILDUP || 0}</b></div>
      <div class="kpi"><div class="mini">ALMOST</div><b>${stageMap.ALMOST || 0}</b></div>
      <div class="kpi"><div class="mini">ENTRY</div><b>${stageMap.ENTRY || 0}</b></div>
    </div>
  `;

  const renderSide = (title, latest, sum, tsLabel) => `
    <div class="card">
      <div class="head">
        <div>
          <div class="title">${title}</div>
          <div class="mini">Laatste scan: ${tsLabel}</div>
        </div>
        <div class="kpis">
          ${badge(latest?.btc?.state)}
          ${pill(`mode: ${String(latest?.mode || "-")}`)}
        </div>
      </div>

      ${kpiRow(sum.stageMap)}

      <div class="boxes">
        ${renderTopList("Top ENTRY gates", sum.topGate)}
        ${renderTopList("Top OB reasons", sum.topObReason)}
        ${renderTopList("Top OB status", sum.topObStatus)}
      </div>

      <div style="margin-top:12px">
        <div class="boxtitle">Wat moet je aanpassen (automatisch)</div>
        ${renderSuggestions(sum.suggestions)}
      </div>

      ${renderCoinsTable(sum.coins, 25)}
    </div>
  `;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Analyze MAIN</title>
  <style>${css}</style>
</head>
<body>
  <div class="wrap">
    <h1>Analyze MAIN (LONG vs SHORT)</h1>

    <div class="topline">
      ${pill(tokenPresent ? "Token: ok" : "Token: niet meegestuurd", tokenPresent ? "ok" : "warn")}
      ${pill(`Trades open: ${openTrades.length}`)}
      ${pill(`Events: ${safeArr(events).length}`)}
      ${pill(`Laatste event: ${lastEv?.ts ? fmtDateMin(lastEv.ts) : "-"}`)}
    </div>

    <div class="grid">
      ${renderSide("LONG", longLatest, longSum, longTs)}
      ${renderSide("SHORT", shortLatest, shortSum, shortTs)}
    </div>

    <div class="footer">
      <div class="boxtitle">Test links</div>
      <div class="muted">
        1) Eerst scan draaien (zodat latest gevuld is).<br/>
        2) Daarna deze pagina openen.
      </div>

      <div class="btnrow">
        <a class="link" href="/api/scan?mode=bull&token=JOUW_TOKEN">/api/scan?mode=bull</a>
        <a class="link" href="/api/scan?mode=bear&token=JOUW_TOKEN">/api/scan?mode=bear</a>
        <a class="link" href="/api/analyze-main?token=JOUW_TOKEN">/api/analyze-main (HTML)</a>
        <a class="link" href="/api/analyze-main?format=json&token=JOUW_TOKEN">/api/analyze-main?format=json</a>
      </div>

      <div class="muted" style="margin-top:10px">
        Tip: alles wat je bovenaan ziet (zoals “Direction not consistent” of “Depth too thin”) komt 1-op-1 uit je coin data.
        Dus je hoeft niet meer te gokken: je ziet exact wat er blokkeert.
      </div>
    </div>

  </div>
</body>
</html>`;
}

// ======================================================
// HANDLER
// ======================================================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const format = String(req.query?.format || "html").toLowerCase();
    const tokenPresent = !!req.query?.token;

    const longLatest = await kv.get(keyLatest("bull"));
    const shortLatest = await kv.get(keyLatest("bear"));

    const trades = await readTrades("main");
    const events = await readEvents("main", 500);

    if (format === "json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      return res.end(
        JSON.stringify({
          ok: true,
          ts: Date.now(),
          view: "analyze-main",
          latest: { long: longLatest, short: shortLatest },
          derived: {
            long: summarizeSide(longLatest, "LONG"),
            short: summarizeSide(shortLatest, "SHORT"),
          },
          analytics: {
            tradesCount: safeArr(trades).length,
            eventsCount: safeArr(events).length,
          },
        })
      );
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    return res.end(
      htmlPage({ tokenPresent, longLatest, shortLatest, trades, events })
    );
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}