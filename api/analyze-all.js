// api/analyze-all.js
import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMainLatest,
  keyMoonLatest,
  keyMainPositions,
  keyMoonPositions,
} from "../lib/_moon_core.js";

import { THRESHOLDS } from "../lib/_thresholds.js";

export const config = RUNTIME_CONFIG;

const PERF_STALE_MS = 6 * 60 * 60 * 1000; // 6h
const PERF_LOCK_TTL_SEC = 60;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function avg(arr) {
  const vals = safeArr(arr).map((x) => n(x, NaN)).filter(Number.isFinite);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

function flattenLatest(latest) {
  const f = latest?.funnel || {};
  return [
    ...safeArr(f.radar),
    ...safeArr(f.buildup),
    ...safeArr(f.almost),
    ...safeArr(f.elite_ignition),
    ...safeArr(f.elite_expansion),
    ...safeArr(f.elite_cascade),
    ...safeArr(f.hold),
    ...safeArr(f.entry),
  ];
}

function analyzeCoin(coin) {
  const bottlenecks = [];

  const timingScore = n(coin?.timingScore, 0);
  const liquidityScore = n(coin?.liquidityScore, 0);
  const qualityScore = n(coin?.qualityScore, 0);
  const marketScore = n(coin?.marketScore, 0);

  if (timingScore < THRESHOLDS.timing.current) {
    bottlenecks.push({ key: "timing", label: "Timing", severity: (THRESHOLDS.timing.current - timingScore) / 10 });
  }
  if (qualityScore < THRESHOLDS.quality.current) {
    bottlenecks.push({ key: "quality", label: "Quality", severity: (THRESHOLDS.quality.current - qualityScore) / 10 });
  }
  if (marketScore < THRESHOLDS.market.current) {
    bottlenecks.push({ key: "market", label: "Market", severity: (THRESHOLDS.market.current - marketScore) / 10 });
  }
  if (liquidityScore < 60) {
    bottlenecks.push({ key: "liquidity", label: "Liquidity", severity: (60 - liquidityScore) / 10 });
  }

  return { bottlenecks };
}

function summarize(coins, name) {
  const map = {};

  for (const c of safeArr(coins)) {
    const r = analyzeCoin(c);
    for (const b of r.bottlenecks) {
      if (!map[b.key]) map[b.key] = { key: b.key, label: b.label, hits: 0, impact: 0 };
      map[b.key].hits += 1;
      map[b.key].impact += b.severity;
    }
  }

  const table = Object.values(map)
    .map((x) => ({
      filter: x.label,
      hits: x.hits,
      impact: Number(x.impact.toFixed(2)),
      expectedGainPct: Math.min(35, Math.round(x.impact * 12 + x.hits * 0.8)),
    }))
    .sort((a, b) => b.expectedGainPct - a.expectedGainPct);

  return { name, totalCoins: safeArr(coins).length, topFix: table[0] || null, table };
}

function computePerformance(closedTrades) {
  const tradesArr = Array.isArray(closedTrades) ? closedTrades : [];

  if (!tradesArr.length) {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      winRate: 50,
      avgRR: 0,
      drawdown: 0,
      updatedAt: Date.now(),
    };
  }

  let wins = 0;
  let totalRR = 0;

  let equity = 1000;
  let peakEquity = equity;
  let maxDrawdownPct = 0;

  for (const t of tradesArr) {
    const pnlPct = n(t?.pnlPct, 0);
    const rr = n(t?.rr, 0);

    if (pnlPct > 0) wins += 1;
    totalRR += rr;

    equity = equity * (1 + pnlPct / 100);
    peakEquity = Math.max(peakEquity, equity);

    const ddPct = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, ddPct);
  }

  const trades = tradesArr.length;
  const winRate = trades ? (wins / trades) * 100 : 50;
  const avgRR = trades ? totalRR / trades : 0;

  return {
    trades,
    wins,
    losses: trades - wins,
    winRate: Number(winRate.toFixed(1)),
    avgRR: Number(avgRR.toFixed(2)),
    drawdown: Number(maxDrawdownPct.toFixed(1)),
    updatedAt: Date.now(),
  };
}

async function maybeUpdatePerformanceOnce() {
  const lockKey = "analyzeAll:perf:updateLock";
  const got = await kv.set(lockKey, { ts: Date.now() }, { nx: true, ex: PERF_LOCK_TTL_SEC });
  if (!got) return;

  const modes = ["bull", "bear"];

  for (const mode of modes) {
    const mainKey = `main:performance:${mode}`;
    const moonKey = `moon:performance:${mode}`;

    const [mainPerf, moonPerf] = await Promise.all([kv.get(mainKey), kv.get(moonKey)]);

    const mainStale = !mainPerf || (Date.now() - n(mainPerf.updatedAt, 0) > PERF_STALE_MS);
    const moonStale = !moonPerf || (Date.now() - n(moonPerf.updatedAt, 0) > PERF_STALE_MS);

    if (mainStale) {
      const mainPositions = (await kv.get(keyMainPositions(mode))) || { open: [], closed: [] };
      await kv.set(mainKey, computePerformance(mainPositions.closed), { ex: 60 * 60 * 24 * 7 });
    }
    if (moonStale) {
      const moonPositions = (await kv.get(keyMoonPositions(mode))) || { open: [], closed: [] };
      await kv.set(moonKey, computePerformance(moonPositions.closed), { ex: 60 * 60 * 24 * 7 });
    }
  }
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");

    await maybeUpdatePerformanceOnce();

    const [mainBull, mainBear, moonBull, moonBear] = await Promise.all([
      kv.get(keyMainLatest("bull")),
      kv.get(keyMainLatest("bear")),
      kv.get(keyMoonLatest("bull")),
      kv.get(keyMoonLatest("bear")),
    ]);

    const payload = {
      ok: true,
      thresholds: THRESHOLDS,
      main: {
        bull: summarize(flattenLatest(mainBull), "Main Bull"),
        bear: summarize(flattenLatest(mainBear), "Main Bear"),
      },
      moon: {
        bull: summarize(flattenLatest(moonBull), "Moon Bull"),
        bear: summarize(flattenLatest(moonBear), "Moon Bear"),
      },
      performance: {
        main: {
          bull: (await kv.get("main:performance:bull")) || { winRate: 50, drawdown: 0 },
          bear: (await kv.get("main:performance:bear")) || { winRate: 50, drawdown: 0 },
        },
        moon: {
          bull: (await kv.get("moon:performance:bull")) || { winRate: 50, drawdown: 0 },
          bear: (await kv.get("moon:performance:bear")) || { winRate: 50, drawdown: 0 },
        },
      },
      updatedAt: Date.now(),
    };

    return res.status(200).json(payload);
  } catch (err) {
    console.error("analyze-all error:", err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}