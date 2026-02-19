// /api/analyze-main.js
import { kv } from "@vercel/kv";
import { SETTINGS } from "./_core.js";

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
function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}
function fmtNum(x, d = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(d);
}
function fmtUsd(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(2)}K`;
  return `$${v.toFixed(2)}`;
}
function durMin(a, b) {
  const A = Number(a || 0);
  const B = Number(b || 0);
  if (!(A > 0 && B > 0)) return null;
  return Math.max(0, Math.round((B - A) / 60000));
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
// COIN/GATE ANALYSE (zoals je al had)
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

  const suggestions = [];

  const btcState = String(latest?.btc?.state || "").toUpperCase();
  if (label === "LONG" && btcState === "BEAR") {
    suggestions.push({
      title: "BTC staat BEAR maar je draait LONG",
      what: "Dan blokkeert je systeem meestal (of je krijgt alleen RADAR).",
      fix: [
        "Optie A: draai SHORT scan als BTC BEAR is.",
        "Optie B: maak je BTC-gate minder streng (NEUTRAL toelaten voor LONG).",
      ],
      where: [
        { file: "/api/_core.js", search: "btcChgGate" },
        { file: "/api/_core.js", search: "btcRange" },
      ],
    });
  }

  const tGate = topN(gateMap, 3);
  const tObReason = topN(obReasonMap, 3);
  const tObStatus = topN(obStatusMap, 3);

  if ((gateMap["OB validating"] || 0) >= 3 || (obStatusMap["validating"] || 0) >= 3) {
    suggestions.push({
      title: "Veel coins blijven hangen op ‘OB validating’",
      what: "Je orderbook meting is te traag of je ENTRY vereist ‘valid’ te vaak.",
      fix: [
        `Huidig: entry.samplesNeed = ${SETTINGS.entry.samplesNeed} → zet bv naar 2 (of 1 voor test)`,
        `Huidig: entry.samplesWindowSec = ${SETTINGS.entry.samplesWindowSec} → zorg dat sampler echt genoeg meetmomenten pakt`,
        `Als je sneller wil: laat ALMOST door als OB nog 'validating' is (staat al aan).`,
      ],
      where: [
        { file: "/api/_core.js", search: "samplesNeed" },
        { file: "/api/_core.js", search: "samplesWindowSec" },
        { file: "/api/_core.js", search: "allowValidatingForAlmost" },
      ],
    });
  }

  if ((obReasonMap["Direction not consistent"] || 0) >= 3) {
    suggestions.push({
      title: "‘Direction not consistent’ komt vaak voor",
      what: "Je OB wil dat bid/ask-dominantie hetzelfde blijft. Bij smallcaps wisselt dat vaak.",
      fix: [
        "Maak je agreement-eis iets lager (minAgree).",
        "Of maak de ‘direction’ check minder streng in je OB code (tolerantie op lor/slope).",
      ],
      where: [
        { file: "/api/_core.js", search: "minAgree" },
        { file: "/api/orderbook.js", search: "Direction not consistent" },
      ],
    });
  }

  const depthGates = Object.keys(gateMap).filter((k) =>
    k.toLowerCase().includes("depth too thin")
  );
  if (depthGates.length) {
    suggestions.push({
      title: "‘Depth too thin’ blokkeert entry",
      what: "Je minimum orderbook diepte (USD) is te hoog voor jouw type coins.",
      fix: [
        `Bull: minDepthUsd1pBull = ${SETTINGS.entry.minDepthUsd1pBull} → zet bv ${Math.max(10_000, Math.round(SETTINGS.entry.minDepthUsd1pBull * 0.7))}`,
        `Bear: minDepthUsd1pBear = ${SETTINGS.entry.minDepthUsd1pBear} → zet bv ${Math.max(10_000, Math.round(SETTINGS.entry.minDepthUsd1pBear * 0.7))}`,
      ],
      where: [
        { file: "/api/_core.js", search: "minDepthUsd1pBull" },
        { file: "/api/_core.js", search: "minDepthUsd1pBear" },
      ],
    });
  }

  if ((stageMap.ENTRY || 0) === 0 && (stageMap.ALMOST || 0) === 0 && (stageMap.BUILDUP || 0) === 0) {
    suggestions.push({
      title: "Alles blijft in RADAR (geen BUILDUP/ALMOST/ENTRY)",
      what: "Dan is je doorstroom te streng.",
      fix: [
        `BUILDUP: vmMin ${SETTINGS.buildup.vmMin} → zet bv ${Math.max(0.08, +(SETTINGS.buildup.vmMin * 0.9).toFixed(3))}`,
        `BUILDUP: volMin ${SETTINGS.buildup.volMin} → zet bv ${Math.max(200_000, Math.round(SETTINGS.buildup.volMin * 0.85))}`,
        `ALMOST: priceFlatMax ${SETTINGS.almost.priceFlatMax}% → zet bv ${(SETTINGS.almost.priceFlatMax + 2).toFixed(1)}%`,
      ],
      where: [
        { file: "/api/_core.js", search: "buildup" },
        { file: "/api/_core.js", search: "almost" },
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
// TRADE-BASED RISK ANALYSE (MAIN)
// Doel: SL te snel? TP te vaak niet? -> “nu → nieuw”
// ======================================================
function normalizeExitKind(t) {
  const k =
    String(t?.exitKind || t?.closeKind || t?.resultKind || t?.reason || t?.kind || "")
      .toUpperCase();

  // vaak voorkomende varianten
  if (k.includes("STOP") || k === "SL") return "SL";
  if (k.includes("TAKE") || k.includes("TP")) return "TP";
  if (k.includes("MANUAL")) return "MANUAL";
  if (k.includes("TIME")) return "TIME";
  if (k.includes("BTC")) return "BTC";
  return k || "UNKNOWN";
}

function isClosed(t) {
  const s = String(t?.status || "").toUpperCase();
  return s === "CLOSED" || s === "DONE" || !!t?.closedAt || !!t?.exitTs;
}

function getOpenedAt(t) {
  return (
    Number(t?.openedAt || t?.openTs || t?.entryTs || t?.tsOpen || t?.ts || 0) || 0
  );
}
function getClosedAt(t) {
  return (
    Number(t?.closedAt || t?.closeTs || t?.exitTs || t?.tsClose || 0) || 0
  );
}

function getPnLPct(t) {
  const v = Number(t?.pnlPct ?? t?.pnl_percent ?? t?.pnl ?? t?.resultPct ?? t?.profitPct);
  if (Number.isFinite(v)) return v;

  // fallback: calc from entry/exit if present
  const e = Number(t?.entryPrice || t?.entry || t?.priceEntry);
  const x = Number(t?.exitPrice || t?.exit || t?.priceExit);
  const mode = String(t?.mode || t?.side || "").toLowerCase();
  if (e > 0 && x > 0) {
    if (mode === "bear" || mode === "short") return ((e - x) / e) * 100;
    return ((x - e) / e) * 100;
  }
  return null;
}

function tradeStats(trades, { lookback = 200 } = {}) {
  const list = safeArr(trades).slice(-lookback).filter(Boolean);
  const closed = list.filter((t) => isClosed(t));
  const open = list.filter((t) => !isClosed(t));

  const byKind = { SL: 0, TP: 0, MANUAL: 0, TIME: 0, BTC: 0, UNKNOWN: 0 };
  let wins = 0;
  let losses = 0;
  let pnlSum = 0;
  let pnlN = 0;

  let slFast30 = 0;
  let slFast60 = 0;
  let slCount = 0;
  let tpCount = 0;

  for (const t of closed) {
    const kind = normalizeExitKind(t);
    byKind[kind] = (byKind[kind] || 0) + 1;

    if (kind === "SL") slCount++;
    if (kind === "TP") tpCount++;

    const pnl = getPnLPct(t);
    if (Number.isFinite(pnl)) {
      pnlSum += pnl;
      pnlN++;
      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }

    if (kind === "SL") {
      const m = durMin(getOpenedAt(t), getClosedAt(t));
      if (m != null && m <= 30) slFast30++;
      if (m != null && m <= 60) slFast60++;
    }
  }

  const closedN = closed.length || 0;
  const wr = closedN ? wins / closedN : 0;
  const avgPnl = pnlN ? pnlSum / pnlN : 0;

  const slFast30Pct = slCount ? slFast30 / slCount : 0;
  const slFast60Pct = slCount ? slFast60 / slCount : 0;

  return {
    total: list.length,
    closed: closedN,
    open: open.length,
    byKind,
    winrate: wr,
    avgPnl,
    slCount,
    tpCount,
    slFast30Pct,
    slFast60Pct,
  };
}

function riskSuggestionFromTrades(stats) {
  // Huidige MAIN: computeSLTP gebruikt 1.8 & 3.0 ATR
  // We geven advies als je data genoeg is.
  const curSlAtrMul = 1.8;
  const curTpAtrMul = 3.0;

  const minClosed = 20;
  if (!stats || stats.closed < minClosed) {
    return {
      ok: false,
      note: `Te weinig gesloten trades (${stats?.closed || 0}). Pas aan zodra je ≥ ${minClosed} closed trades hebt.`,
      current: { slAtrMul: curSlAtrMul, tpAtrMul: curTpAtrMul },
      suggested: null,
      why: [],
    };
  }

  const why = [];

  // Heuristiek:
  // - Veel snelle SL’s => SL is te strak
  // - Heel weinig TP hits => TP is te ver (of entries niet goed)
  // - Heel veel TP maar lage avgPnL => TP te dichtbij
  const slFast = stats.slFast60Pct;
  const tpHitRate = stats.closed ? stats.tpCount / stats.closed : 0;

  let newSl = curSlAtrMul;
  let newTp = curTpAtrMul;

  if (slFast >= 0.45) {
    why.push(`SL wordt vaak snel geraakt (${Math.round(slFast * 100)}% binnen 60 min) → SL is te strak.`);
    newSl = curSlAtrMul + 0.5; // ruimer
  } else if (slFast >= 0.30) {
    why.push(`SL wordt best vaak snel geraakt (${Math.round(slFast * 100)}% binnen 60 min) → SL iets ruimer.`);
    newSl = curSlAtrMul + 0.3;
  }

  if (tpHitRate <= 0.12) {
    why.push(`TP wordt weinig geraakt (${Math.round(tpHitRate * 100)}% van closed) → TP is waarschijnlijk te ver of entries zijn te vroeg.`);
    // hier kiezen we NIET blind “dichterbij”, want jij zei: coin gaat vaak nog verder.
    // Dus we koppelen aan winrate + avgPnL:
    if (stats.winrate >= 0.55) {
      why.push(`Winrate is ok (${Math.round(stats.winrate * 100)}%) → TP mag juist verder (je pakt te weinig van de move).`);
      newTp = curTpAtrMul + 0.4;
    } else {
      why.push(`Winrate is laag (${Math.round(stats.winrate * 100)}%) → eerst entries/filters strakker maken, TP niet agressief aanpassen.`);
      newTp = curTpAtrMul;
    }
  } else if (tpHitRate >= 0.45 && stats.avgPnl < 0.6) {
    why.push(`Veel TP’s maar lage gemiddelde winst (${fmtNum(stats.avgPnl, 2)}%) → TP te dichtbij.`);
    newTp = curTpAtrMul + 0.3;
  } else if (tpHitRate <= 0.20 && stats.winrate >= 0.60) {
    why.push(`Weinig TP maar hoge winrate → TP staat waarschijnlijk te dichtbij/SL te strak; we zetten TP iets verder.`);
    newTp = curTpAtrMul + 0.3;
  }

  newSl = clamp(newSl, 1.8, 3.0);
  newTp = clamp(newTp, 2.2, 4.2);

  const changed = Math.abs(newSl - curSlAtrMul) > 0.001 || Math.abs(newTp - curTpAtrMul) > 0.001;

  return {
    ok: true,
    note: changed ? "Advies gebaseerd op jouw gesloten trades." : "Geen sterke aanwijzing om SL/TP te veranderen.",
    current: { slAtrMul: curSlAtrMul, tpAtrMul: curTpAtrMul },
    suggested: { slAtrMul: newSl, tpAtrMul: newTp },
    why,
  };
}

// ======================================================
// HTML UI helpers
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

function renderSettingsBox(riskAdvice, stats) {
  const e = SETTINGS.entry || {};
  const lines = [
    `<li><code>entry.obScoreMin</code>: <b>${e.obScoreMin}</b></li>`,
    `<li><code>entry.spreadMaxPct</code>: <b>${e.spreadMaxPct}</b></li>`,
    `<li><code>entry.largestOrderRatioMax</code>: <b>${e.largestOrderRatioMax}</b></li>`,
    `<li><code>entry.samplesNeed</code>: <b>${e.samplesNeed}</b></li>`,
    `<li><code>entry.samplesWindowSec</code>: <b>${e.samplesWindowSec}</b></li>`,
    `<li><code>entry.minAgree</code>: <b>${e.minAgree}</b></li>`,
    `<li><code>entry.minDepthUsd1pBull</code>: <b>${fmtUsd(e.minDepthUsd1pBull)}</b></li>`,
    `<li><code>entry.minDepthUsd1pBear</code>: <b>${fmtUsd(e.minDepthUsd1pBear)}</b></li>`,
    `<li><code>entry.minConfidence</code>: <b>${e.minConfidence}</b></li>`,
    `<li><code>entry.entryConsistencyMin</code>: <b>${Math.round(e.entryConsistencyMin * 100)}%</b></li>`,
  ].join("");

  const t = stats || {};
  const tradeLine = `
    <div class="muted" style="margin-top:6px">
      Closed: <b>${t.closed || 0}</b> • Winrate: <b>${Math.round((t.winrate || 0) * 100)}%</b> •
      SL: <b>${t.slCount || 0}</b> • TP: <b>${t.tpCount || 0}</b> •
      SL snel (≤60m): <b>${Math.round((t.slFast60Pct || 0) * 100)}%</b>
    </div>
  `;

  const cur = riskAdvice?.current || { slAtrMul: 1.8, tpAtrMul: 3.0 };
  const sug = riskAdvice?.suggested;

  const why = (riskAdvice?.why || []).map((x) => `<li>${x}</li>`).join("") || `<li class="muted">n/a</li>`;

  const adviceBlock = sug
    ? `
      <ul class="list">
        <li><b>SL ATR-mul</b>: ${cur.slAtrMul} → <b>${fmtNum(sug.slAtrMul, 2)}</b></li>
        <li><b>TP ATR-mul</b>: ${cur.tpAtrMul} → <b>${fmtNum(sug.tpAtrMul, 2)}</b></li>
      </ul>
      <div class="muted">${riskAdvice.note}</div>
      <div class="miniTitle">Waarom</div>
      <ul class="list">${why}</ul>
      <div class="muted" style="margin-top:8px">
        Waar aanpassen: <code>/api/_core.js</code> → functie <code>computeSLTP()</code> (zie onder).
      </div>
    `
    : `
      <div class="muted">${riskAdvice?.note || "n/a"}</div>
      <div class="miniTitle">Waarom</div>
      <ul class="list">${why}</ul>
    `;

  return `
    <div class="box" style="margin-top:12px">
      <div class="boxtitle">Huidige ENTRY/OB instellingen (MAIN)</div>
      <ul class="list">${lines}</ul>
      ${tradeLine}

      <div class="boxtitle" style="margin-top:12px">SL/TP diagnose op basis van trades</div>
      ${adviceBlock}
    </div>
  `;
}

// ======================================================
// HTML PAGE
// ======================================================
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

  const openTrades = safeArr(trades).filter((t) => String(t?.status).toUpperCase() === "OPEN");
  const lastEv = safeArr(events).slice(-1)[0] || null;

  const stats = tradeStats(trades, { lookback: 250 });
  const riskAdvice = riskSuggestionFromTrades(stats);

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
      ${pill(\`Trades open: ${openTrades.length}\`)}
      ${pill(\`Trades closed (lookback): ${stats.closed}\`)}
      ${pill(\`Events: ${safeArr(events).length}\`)}
      ${pill(\`Laatste event: ${lastEv?.ts ? fmtDateMin(lastEv.ts) : "-"}\`)}
    </div>

    ${renderSettingsBox(riskAdvice, stats)}

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
        Tip: dit scherm kijkt naar jouw coin gates én jouw trades.
        Dus je krijgt advies met “nu → nieuw”, en je ziet precies welke bottleneck (OB/Depth/Spread/etc) jouw entries blokkeert.
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

    const stats = tradeStats(trades, { lookback: 250 });
    const riskAdvice = riskSuggestionFromTrades(stats);

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
          tradeAnalytics: {
            lookback: 250,
            stats,
            riskAdvice,
            settingsSnapshot: {
              entry: SETTINGS.entry,
              buildup: SETTINGS.buildup,
              almost: SETTINGS.almost,
            },
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