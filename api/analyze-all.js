import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import * as moonCore from "../lib/_moon_core.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function scoreFromFailRate(fails, total) {
  if (!total) return 5;
  const failRate = fails / total;
  return Math.max(1, Math.min(10, Math.round((1 - failRate) * 10)));
}

function adviceBlock(name, score, issue, fix) {
  return { filter: name, score, issue, fix, target: "→ naar 9/10" };
}

function safeStage(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x;
  if (typeof x === "object") return Object.values(x);
  return [];
}

function flattenMainCoins(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeStage(f.radar),
    ...safeStage(f.buildup),
    ...safeStage(f.almost),
    ...safeStage(f.entry),
    ...safeStage(f.elite_ignition),
    ...safeStage(f.elite_expansion),
    ...safeStage(f.elite_cascade),
    ...safeStage(f.hold),
  ];
}

function analyzeMain(coins) {
  const total = coins.length || 1;

  let fails = {
    btc: 0,
    breakout: 0,
    persistence: 0,
    entry: 0,
    liquidity: 0,
  };

  for (const c of coins) {
    const checklist = c?.execution?.checklist || [];
    const reason = String(c?.execution?.reason || "").toLowerCase();

    for (const item of checklist) {
      if (!item?.ok) {
        const name = String(item?.name || "").toLowerCase();
        if (name.includes("btc")) fails.btc++;
        if (name.includes("breakout")) fails.breakout++;
        if (name.includes("persist")) fails.persistence++;
        if (name.includes("entry")) fails.entry++;
        if (name.includes("liq") || name.includes("spread") || name.includes("depth")) fails.liquidity++;
      }
    }

    if (reason.includes("btc")) fails.btc++;
    if (reason.includes("breakout")) fails.breakout++;
    if (reason.includes("persist")) fails.persistence++;
    if (reason.includes("entry")) fails.entry++;
    if (reason.includes("liq") || reason.includes("spread") || reason.includes("depth")) fails.liquidity++;
  }

  return [
    adviceBlock(
      "BTC Alignment",
      scoreFromFailRate(fails.btc, total),
      fails.btc ? "Te veel coins falen op BTC-richting of marktregime" : "BTC-filter werkt goed",
      "Versoepel BTC confirmatie of regime-check licht"
    ),
    adviceBlock(
      "Breakout",
      scoreFromFailRate(fails.breakout, total),
      fails.breakout ? "Breakout-filter blokkeert veel setups" : "Breakout-filter werkt goed",
      "Verlaag breakout pressure / breakout ready threshold"
    ),
    adviceBlock(
      "Persistence",
      scoreFromFailRate(fails.persistence, total),
      fails.persistence ? "Persistence-score is te streng" : "Persistence-filter werkt goed",
      "Verlaag persistence eis met 5-10%"
    ),
    adviceBlock(
      "Entry Quality",
      scoreFromFailRate(fails.entry, total),
      fails.entry ? "Entry-quality laat te weinig setups door" : "Entry-quality werkt goed",
      "Versoepel entryQuality threshold licht"
    ),
    adviceBlock(
      "Liquidity",
      scoreFromFailRate(fails.liquidity, total),
      fails.liquidity ? "Orderboek / spread / depth blokkeert teveel coins" : "Liquiditeitsfilter werkt goed",
      "Verlaag depthFloor of maak spread-limiet iets ruimer"
    ),
  ];
}

function analyzeMoon(diags) {
  const total = diags.length || 1;

  let eliteFails = 0;
  let obFails = 0;
  let stabilityFails = 0;
  let radarFails = 0;

  for (const d of diags) {
    const r = d?.reasons || {};
    eliteFails += Object.values(r.eliteWhy || {}).reduce((a, b) => a + n(b), 0);
    obFails += Object.values(r.obReason || {}).reduce((a, b) => a + n(b), 0);
    stabilityFails += Object.values(r.eliteExtraFail || {}).reduce((a, b) => a + n(b), 0);
    radarFails += Object.values(r.radarOut || {}).reduce((a, b) => a + n(b), 0);
  }

  return [
    adviceBlock(
      "Elite Filter",
      scoreFromFailRate(eliteFails, total * 5),
      eliteFails ? "Te weinig coins halen ELITE" : "Elite-filter werkt goed",
      "Versoepel elite thresholds zoals vm / velocity / confidence"
    ),
    adviceBlock(
      "Orderbook",
      scoreFromFailRate(obFails, total * 5),
      obFails ? "Moon valt vaak uit op orderboek" : "Orderboek-filter werkt goed",
      "Verlaag depth-eis of maak spreadMax iets ruimer"
    ),
    adviceBlock(
      "Stability",
      scoreFromFailRate(stabilityFails, total * 5),
      stabilityFails ? "Rolling / stabiliteit blokkeert veel coins" : "Stability-filter werkt goed",
      "Verlaag rolling strictheid of elite extra fail drempel"
    ),
    adviceBlock(
      "Radar Intake",
      scoreFromFailRate(radarFails, total * 5),
      radarFails ? "Te veel coins vallen al af in radar" : "Radar-intake werkt goed",
      "Versoepel radar-out filters licht"
    ),
  ];
}

function analyzeTrades(trades) {
  const total = trades.length || 1;

  let giveback = 0;
  let losses = 0;
  const reasons = {};

  for (const t of trades) {
    const max = n(t?.maxPnlPct);
    const pnl = n(t?.pnlPct);
    const reason = String(t?.reason || "UNKNOWN");

    giveback += Math.max(0, max - pnl);
    if (pnl < 0) losses++;
    reasons[reason] = (reasons[reason] || 0) + 1;
  }

  const avgGiveback = giveback / total;
  const givebackScore = Math.max(1, Math.min(10, Math.round(10 - avgGiveback)));
  const lossScore = Math.max(1, Math.min(10, Math.round(10 - (losses / total) * 10)));

  const topExitReason =
    Object.entries(reasons).sort((a, b) => b[1] - a[1])[0]?.[0] || "UNKNOWN";

  return [
    adviceBlock(
      "Giveback",
      givebackScore,
      avgGiveback > 1.5 ? `Te veel winst teruggegeven (${avgGiveback.toFixed(2)}%)` : "Giveback is gezond",
      "Zet trailing TP strakker na TP1"
    ),
    adviceBlock(
      "Loss Rate",
      lossScore,
      losses ? `Te veel verliezende trades (${losses}/${total})` : "Loss rate is gezond",
      "Maak entry strenger of verbeter BTC/richting-filter"
    ),
    adviceBlock(
      "Exit Logic",
      Math.max(1, Math.min(10, lossScore)),
      `Meest voorkomende exit reden: ${topExitReason}`,
      "Controleer of SL/timeout/exit reden te streng of te vroeg is"
    ),
  ];
}

function renderSection(title, items) {
  return `
    <div style="margin-bottom:28px">
      <h2 style="margin:0 0 12px">${title}</h2>
      <div style="display:grid;gap:10px">
        ${items
          .map(
            (i) => `
          <div style="background:#111826;border:1px solid #1f2a3a;padding:14px;border-radius:12px">
            <div style="font-size:18px;font-weight:700">${i.filter} — ${i.score}/10</div>
            <div style="margin-top:6px;color:#ffb4b4">❌ ${i.issue}</div>
            <div style="margin-top:6px;color:#b8f7c5">✔ ${i.fix}</div>
            <div style="margin-top:6px;color:#9fb0c3">${i.target}</div>
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;
}

export default async function handler(req, res) {
  try {
    const secret = String(req.query?.secret || "");
    if (secret !== "lara-roos") {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const keyMainLatest =
      moonCore.keyMainLatest || ((mode) => `latest:${String(mode || "bull").toLowerCase()}`);
    const keyMoonDiagList =
      moonCore.keyMoonDiagList || ((m) => `moon:diag:${m}`);

    const [bullLatest, bearLatest, trades, moonBullRaw, moonBearRaw] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      readEvents("trade_closed", 4000),
      kv.lrange(keyMoonDiagList("bull"), 0, 19).catch(() => []),
      kv.lrange(keyMoonDiagList("bear"), 0, 19).catch(() => []),
    ]);

    const bullCoins = flattenMainCoins(bullLatest);
    const bearCoins = flattenMainCoins(bearLatest);
    const allMainCoins = [...bullCoins, ...bearCoins];

    const moonBull = (moonBullRaw || []).map((x) => {
      try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; }
    }).filter(Boolean);

    const moonBear = (moonBearRaw || []).map((x) => {
      try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; }
    }).filter(Boolean);

    const allMoon = [...moonBull, ...moonBear];

    const main = analyzeMain(allMainCoins);
    const moon = analyzeMoon(allMoon);
    const trade = analyzeTrades(Array.isArray(trades) ? trades : []);

    if (String(req.query?.format || "").toLowerCase() === "json") {
      return res.status(200).json({
        ok: true,
        main,
        moon,
        trade,
        stats: {
          mainCoins: allMainCoins.length,
          moonScans: allMoon.length,
          trades: Array.isArray(trades) ? trades.length : 0,
        },
      });
    }

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Complete Analyse</title>
      </head>
      <body style="background:#0b0f14;color:#e6edf3;font-family:ui-sans-serif;padding:20px;margin:0">
        <div style="max-width:1100px;margin:0 auto">
          <h1 style="margin-top:0">🔥 Complete systeemanalyse</h1>
          <div style="margin-bottom:18px;color:#9fb0c3">
            Main coins: ${allMainCoins.length} · Moon scans: ${allMoon.length} · Trades: ${Array.isArray(trades) ? trades.length : 0}
          </div>

          ${renderSection("MAIN FUNNEL", main)}
          ${renderSection("MOON FUNNEL", moon)}
          ${renderSection("TRADE FUNNEL", trade)}
        </div>
      </body>
      </html>
    `;

    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.status(200).end(html);
  } catch (e) {
    console.error("analyze-all error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}