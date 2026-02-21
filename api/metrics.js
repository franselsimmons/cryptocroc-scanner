// /api/metrics.js
import { requireSecret } from "./_core_bull.js";
import { keyTrades, readEvents, safeArr } from "./_analytics.js";
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs20.x" };

function n(x) { const v = Number(x); return Number.isFinite(v) ? v : 0; }
function pct(x) { return +n(x).toFixed(2); }

function summarizeTrades(trades, mode) {
  const list = trades.filter(t => String(t.mode) === mode && String(t.status) === "CLOSED");

  const total = list.length;
  const wins = list.filter(t => String(t.exitReason) === "TP").length;
  const losses = list.filter(t => String(t.exitReason) === "SL").length;

  const avgPnl = total ? list.reduce((a,b)=>a+n(b.pnlPct),0)/total : 0;

  const tooEarly = list.filter(t =>
    String(t.exitReason)==="TP" &&
    t.postBestPct != null &&
    n(t.postBestPct) > n(t.pnlPct) + 5
  ).length;

  const tooLate = list.filter(t =>
    String(t.exitReason)==="SL" &&
    n(t.mfePct) > 5
  ).length;

  return {
    total,
    wins,
    losses,
    winrate: total ? pct((wins/total)*100) : 0,
    avgPnlPct: pct(avgPnl),
    tooEarly,
    tooLate,
  };
}

function stageLeakReport(events, mode, wantStages) {
  const ev = events.filter(e => String(e.mode) === mode);
  const stages = wantStages;

  const promoted = {};
  const demoted = {};
  const seen = {};
  for (const s of stages) seen[s] = 0;

  const idx = (s) => stages.indexOf(String(s));

  for (const e of ev) {
    const from = String(e.from || "");
    const to = String(e.to || "");
    if (!stages.includes(to)) continue;

    seen[to] = (seen[to] || 0) + 1;

    if (stages.includes(from)) {
      const a = idx(from);
      const b = idx(to);
      const k = `${from}->${to}`;
      if (b > a) promoted[k] = (promoted[k] || 0) + 1;
      if (b < a) demoted[k] = (demoted[k] || 0) + 1;
    }
  }

  function conv(from, to) {
    const denom = seen[from] || 0;
    const num = promoted[`${from}->${to}`] || 0;
    return denom ? pct((num/denom)*100) : 0;
  }
  function backRate(from, to) {
    const denom = seen[from] || 0;
    const num = demoted[`${from}->${to}`] || 0;
    return denom ? pct((num/denom)*100) : 0;
  }

  const leaks = [];
  for (const s of stages) {
    const downs = Object.entries(demoted)
      .filter(([k]) => k.startsWith(`${s}->`))
      .map(([k,v]) => ({ k, v }));

    if (!downs.length) continue;
    downs.sort((a,b)=>b.v-a.v);
    const top = downs[0];

    leaks.push({
      stage: s,
      biggestDrop: top.k,
      count: top.v,
      note:
        s === "ALMOST"
          ? "Hier lekt vaak kwaliteit: kijk naar confidence/OB/consistency (dubbel tellen voorkomen)."
          : s === "BUILDUP"
            ? "Hier zie je vaak ‘vals momentum’: check VM / volAcc / range caps."
            : s === "RADAR"
              ? "Veel terugval hier = radar te los óf buildup te streng."
              : "Check drempels + exit/management.",
    });
  }

  return {
    conversionPct: stages.length >= 3 ? {
      radar_to_buildup: conv(stages[0], stages[1]),
      buildup_to_almost: conv(stages[1], stages[2]),
      almost_to_entry_or_elite: stages.includes("ENTRY")
        ? conv("ALMOST", "ENTRY")
        : stages.includes("ELITE")
          ? conv("ALMOST", "ELITE")
          : 0,
      buildup_back_to_radar: backRate("BUILDUP", "RADAR"),
      almost_back_to_buildup: backRate("ALMOST", "BUILDUP"),
    } : {},
    leaks,
    sampleSizeEvents: ev.length,
  };
}

function multiFilterOptimizer(trades, mode, cfg) {
  const list = trades
    .filter(t => String(t.mode) === mode && String(t.status) === "CLOSED")
    .filter(t => t && t.snap);

  if (list.length < (cfg.minTrades || 30)) {
    return { ok:false, note:`Not enough CLOSED trades (${list.length}) for optimizer yet.` };
  }

  const vmGrid = cfg.grids?.vm || [0.12,0.14,0.16,0.18,0.20,0.22,0.24];
  const confGrid = cfg.grids?.conf || [60,65,70,75,80,85];
  const spreadGrid = cfg.grids?.spread || [0.25,0.35,0.50,0.75,1.00,1.25];
  const depthGrid = cfg.grids?.depth || [25000,50000,75000,100000,150000,200000];

  function snapVm(t) { return n(t.snap?.vm); }
  function snapConf(t) { return n(t.snap?.confidence); }
  function snapSpread(t) { return n(t.snap?.spreadPct); }
  function snapDepth(t) {
    const a = n(t.snap?.depthMinUsd1p);
    const b = n(t.snap?.depthUsd);
    return a > 0 ? a : b;
  }

  function scoreSet(picked) {
    const total = picked.length;
    if (!total) return null;

    const winsArr = picked.filter(t => String(t.exitReason) === "TP");
    const lossArr = picked.filter(t => String(t.exitReason) === "SL");

    const wins = winsArr.length;
    const losses = lossArr.length;

    const avg = picked.reduce((a,b)=>a+n(b.pnlPct),0)/total;
    const avgWin = wins ? winsArr.reduce((a,b)=>a+n(b.pnlPct),0)/wins : 0;
    const avgLoss = losses ? lossArr.reduce((a,b)=>a+n(b.pnlPct),0)/losses : 0;

    const winrate = total ? (wins/total) : 0;
    const lossrate = total ? (losses/total) : 0;

    const expectancy = (winrate * avgWin) + (lossrate * avgLoss);

    return {
      total,
      wins,
      losses,
      winratePct: pct(winrate*100),
      avgPnlPct: pct(avg),
      expectancyPct: pct(expectancy),
      avgWinPct: pct(avgWin),
      avgLossPct: pct(avgLoss),
    };
  }

  let bestAvg = null;
  let bestExp = null;

  for (const vmMin of vmGrid) {
    for (const confMin of confGrid) {
      for (const spreadMax of spreadGrid) {
        for (const depthMin of depthGrid) {
          const picked = list.filter(t =>
            snapVm(t) >= vmMin &&
            snapConf(t) >= confMin &&
            (snapSpread(t) === 0 ? true : snapSpread(t) <= spreadMax) &&
            snapDepth(t) >= depthMin
          );

          if (picked.length < (cfg.minTrades || 30)) continue;

          const s = scoreSet(picked);
          if (!s) continue;

          const pack = { vmMin, confMin, spreadMax, depthMin, score: s };

          if (!bestAvg || s.avgPnlPct > bestAvg.score.avgPnlPct) bestAvg = pack;
          if (!bestExp || s.expectancyPct > bestExp.score.expectancyPct) bestExp = pack;
        }
      }
    }
  }

  if (!bestAvg) return { ok:false, note:"No combo produced enough trades. Lower minTrades or widen window." };

  return {
    ok:true,
    bestAvgPnl: bestAvg,
    bestExpectancy: bestExp,
    note: "Optimizer gebruikt jouw echte CLOSED trades + post-tracking (te vroeg/te laat zit erin).",
  };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const tradesMain = safeArr(await kv.get(keyTrades("main")));
    const tradesMoon = safeArr(await kv.get(keyTrades("moon")));

    const evMain = await readEvents("main", 40000);
    const evMoon = await readEvents("moon", 40000);

    const optCfg = {
      minTrades: 30,
      grids: {
        vm: [0.10,0.12,0.14,0.16,0.18,0.20,0.22,0.24,0.26],
        conf: [55,60,65,70,75,80,85],
        spread: [0.25,0.35,0.50,0.75,1.00,1.25,1.50],
        depth: [25000,50000,75000,100000,150000,200000,300000],
      }
    };

    const mainStages = ["RADAR","BUILDUP","ALMOST","ENTRY"];
    const moonStages = ["RADAR","BUILDUP","ALMOST","ELITE"];

    const out = {
      ok: true,
      ts: Date.now(),
      main: {
        bull: {
          trades: summarizeTrades(tradesMain, "bull"),
          leaks: stageLeakReport(evMain, "bull", mainStages),
          optimizer: { multi: multiFilterOptimizer(tradesMain, "bull", optCfg) },
        },
        bear: {
          trades: summarizeTrades(tradesMain, "bear"),
          leaks: stageLeakReport(evMain, "bear", mainStages),
          optimizer: { multi: multiFilterOptimizer(tradesMain, "bear", optCfg) },
        },
      },
      moon: {
        bull: {
          trades: summarizeTrades(tradesMoon, "bull"),
          leaks: stageLeakReport(evMoon, "bull", moonStages),
          optimizer: { multi: multiFilterOptimizer(tradesMoon, "bull", optCfg) },
        },
        bear: {
          trades: summarizeTrades(tradesMoon, "bear"),
          leaks: stageLeakReport(evMoon, "bear", moonStages),
          optimizer: { multi: multiFilterOptimizer(tradesMoon, "bear", optCfg) },
        },
      },
      notes: {
        early: "Te vroeg = TP geraakt, maar postBestPct liep daarna > +5% extra door.",
        late: "Te laat = SL geraakt, maar MFE onderweg was > +5%. (exit/SL management issue)",
        leak: "Leak = veel terugval of lage conversion naar volgende tabel.",
      }
    };

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}