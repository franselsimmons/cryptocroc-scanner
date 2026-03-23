import { kv } from "@vercel/kv";
import { readEvents } from "../lib/_analytics.js";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";
import * as moonCore from "../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

// =============================
// SAFE KEY FALLBACKS
// =============================
const keyMainLatest =
  moonCore.keyMainLatest || ((mode) => `latest:${String(mode || "bull").toLowerCase()}`);
const keyMoonLatest =
  moonCore.keyMoonLatest || ((mode) => `moon:latest:${String(mode || "bull").toLowerCase()}`);
const keyMoonDiagList =
  moonCore.keyMoonDiagList || ((mode) => `moon:diag:${String(mode || "bull").toLowerCase()}`);
const keyMoonPositions =
  moonCore.keyMoonPositions || ((mode) => `moon:positions:${String(mode || "bull").toLowerCase()}`);

// =============================
// HELPERS
// =============================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function fmtDate(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "n/a";
  return d.toLocaleString("nl-NL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function inc(map, key, add = 1) {
  const k = String(key || "unknown");
  map[k] = (map[k] || 0) + add;
}

function avg(arr) {
  const vals = safeArr(arr).map((x) => n(x, NaN)).filter(Number.isFinite);
  if (!vals.length) return 0;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function scoreClass(score10) {
  if (score10 >= 8) return "good";
  if (score10 >= 6) return "warn";
  return "bad";
}

function severityFromPct(pctValue) {
  const p = n(pctValue, 0);
  if (p >= 40) return "bad";
  if (p >= 20) return "warn";
  return "good";
}

function scoreLabel(score10) {
  if (score10 >= 8) return "perfect";
  if (score10 >= 6) return "bijna goed";
  return "probleem";
}

function toScore10(pct100) {
  const s = Math.max(0, Math.min(10, n(pct100, 0) / 10));
  return Math.round(s * 10) / 10;
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
    ...safeStage(f.radar).map((c) => ({ ...c, _stage: c?.stage || "RADAR" })),
    ...safeStage(f.buildup).map((c) => ({ ...c, _stage: c?.stage || "BUILDUP" })),
    ...safeStage(f.almost).map((c) => ({ ...c, _stage: c?.stage || "ALMOST" })),
    ...safeStage(f.entry).map((c) => ({ ...c, _stage: c?.stage || "ENTRY" })),
    ...safeStage(f.elite_ignition).map((c) => ({ ...c, _stage: c?.stage || "ELITE_IGNITION" })),
    ...safeStage(f.elite_expansion).map((c) => ({ ...c, _stage: c?.stage || "ELITE_EXPANSION" })),
    ...safeStage(f.elite_cascade).map((c) => ({ ...c, _stage: c?.stage || "ELITE_CASCADE" })),
    ...safeStage(f.hold).map((c) => ({ ...c, _stage: c?.stage || "HOLD" })),
  ];
}

function flattenMoonCoins(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeStage(f.radar).map((c) => ({ ...c, _stage: c?.stage || "RADAR" })),
    ...safeStage(f.buildup).map((c) => ({ ...c, _stage: c?.stage || "BUILDUP" })),
    ...safeStage(f.almost).map((c) => ({ ...c, _stage: c?.stage || "ALMOST" })),
    ...safeStage(f.entry).map((c) => ({ ...c, _stage: c?.stage || "ENTRY" })),
    ...safeStage(f.elite_ignition).map((c) => ({ ...c, _stage: c?.stage || "ELITE_IGNITION" })),
    ...safeStage(f.elite_expansion).map((c) => ({ ...c, _stage: c?.stage || "ELITE_EXPANSION" })),
    ...safeStage(f.elite_cascade).map((c) => ({ ...c, _stage: c?.stage || "ELITE_CASCADE" })),
    ...safeStage(f.hold).map((c) => ({ ...c, _stage: c?.stage || "HOLD" })),
  ];
}

// =============================
// BOTTLENECK ANALYSIS
// =============================
function analyzeCoinBottlenecks(coin) {
  const out = [];
  const advice = [];

  const timingScore = n(coin?.timingScore, 0);
  const liquidityScore = n(coin?.liquidityScore, 0);
  const qualityScore = n(coin?.qualityScore, 0);
  const marketScore = n(coin?.marketScore, 0);
  const eq = n(coin?.entryQuality, 0);
  const ps = n(coin?.persistenceScore, 0);
  const obScore = n(coin?.ob?.score, 0);
  const spreadPct = n(coin?.ob?.spreadPct, 999);
  const depth = n(coin?.ob?.depthMinUsd1p, 0);
  const breakoutReady = !!coin?.breakout?.ready;
  const breakoutPressure = n(coin?.breakout?.pressure, 0);
  const status = String(coin?.tradeDeskStatus || "UNKNOWN").toUpperCase();
  const exReason = String(coin?.execution?.reason || "").toLowerCase();

  if (timingScore < 60 || (!breakoutReady && breakoutPressure < 55)) {
    out.push("timing faalt");
    advice.push("Wacht op breakout + volume confirmatie");
  }

  if (liquidityScore < 60 || spreadPct > 1.2 || depth < 2500) {
    out.push("liquidity bottleneck");
    advice.push("Focus op coins met sterkere depth en lagere spread");
  }

  if (qualityScore < 60 || eq < 60 || ps < 55) {
    out.push("kwaliteit te laag");
    advice.push("Alleen high conviction setups doorlaten");
  }

  if (marketScore < 45) {
    out.push("markt tegen");
    advice.push("Trade meer met BTC trend en regime mee");
  }

  if (status === "WATCH") {
    out.push("blijft hangen in watch");
    advice.push("Verlaag entry-frictie pas als kwaliteit en timing stabiel zijn");
  }

  if (status === "IGNORE") {
    out.push("komt niet door trade desk");
    advice.push("Check strengste execution filters en drempels");
  }

  if (exReason.includes("breakout")) {
    out.push("breakout niet sterk genoeg");
    advice.push("Verlaag breakout eis licht of wacht op sterkere pressure");
  }

  if (exReason.includes("liquidity") || exReason.includes("depth") || exReason.includes("spread")) {
    out.push("execution blokkeert op liquiditeit");
    advice.push("Verlaag spread/depth filter licht of trade alleen diepere coins");
  }

  if (Math.abs(obScore) < 0.008) {
    out.push("orderbook overtuigt niet");
    advice.push("Wacht op sterker orderbook voordeel");
  }

  return {
    bottlenecks: Array.from(new Set(out)),
    advice: Array.from(new Set(advice)),
  };
}

function summarizeProblemCoins(coins, sectionName) {
  const list = [];
  const counters = {
    timing: 0,
    liquidity: 0,
    quality: 0,
    market: 0,
    watch: 0,
    ignored: 0,
  };

  for (const coin of safeArr(coins)) {
    const b = analyzeCoinBottlenecks(coin);
    const scoreRaw = avg([
      n(coin?.timingScore, 0),
      n(coin?.liquidityScore, 0),
      n(coin?.qualityScore, 0),
      n(coin?.marketScore, 0),
    ]);

    const score = toScore10(scoreRaw);

    if (!b.bottlenecks.length) continue;

    for (const x of b.bottlenecks) {
      const t = x.toLowerCase();
      if (t.includes("timing")) counters.timing++;
      if (t.includes("liquidity")) counters.liquidity++;
      if (t.includes("kwaliteit")) counters.quality++;
      if (t.includes("markt")) counters.market++;
      if (t.includes("watch")) counters.watch++;
      if (t.includes("trade desk")) counters.ignored++;
    }

    list.push({
      id: `${sectionName}:${coin?.symbol || "unknown"}`,
      symbol: coin?.symbol || "UNKNOWN",
      stage: coin?.stage || coin?._stage || "-",
      score,
      scoreRaw,
      bottlenecks: b.bottlenecks,
      advice: b.advice,
      tradeDeskStatus: coin?.tradeDeskStatus || "-",
      entryQuality: n(coin?.entryQuality, 0),
      persistenceScore: n(coin?.persistenceScore, 0),
      timingScore: n(coin?.timingScore, 0),
      liquidityScore: n(coin?.liquidityScore, 0),
      qualityScore: n(coin?.qualityScore, 0),
      marketScore: n(coin?.marketScore, 0),
    });
  }

  list.sort((a, b) => a.score - b.score || a.symbol.localeCompare(b.symbol));

  return { problems: list.slice(0, 24), counters };
}

function analyzeTrades(events) {
  const closes = safeArr(events);
  const out = {
    totalTrades: closes.length,
    avgGiveback: 0,
    reasons: {},
    problems: [],
    counters: {
      timing: 0,
      liquidity: 0,
      quality: 0,
      market: 0,
    },
  };

  if (!closes.length) return out;

  let givebackSum = 0;

  for (const t of closes) {
    const reason = String(t?.reason || "UNKNOWN");
    inc(out.reasons, reason);

    const max = n(t?.maxPnlPct, 0);
    const pnl = n(t?.pnlPct, 0);
    const giveback = Math.max(0, max - pnl);
    givebackSum += giveback;

    const bottlenecks = [];
    const advice = [];

    if (giveback > 1.5) {
      bottlenecks.push("timing exit te laat");
      advice.push("Trailing TP strakker na TP1");
      out.counters.timing++;
    }

    if (/slippage|spread|depth|liquid/i.test(reason)) {
      bottlenecks.push("liquidity exit probleem");
      advice.push("Trade alleen coins met betere liquiditeit");
      out.counters.liquidity++;
    }

    if (/timeout|weak|quality|invalid/i.test(reason)) {
      bottlenecks.push("kwaliteit setup zwak");
      advice.push("Laat zwakke setups sneller los");
      out.counters.quality++;
    }

    if (/btc|market|regime/i.test(reason)) {
      bottlenecks.push("