// lib/tradeAnalytics.js
import { kv } from "@vercel/kv";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function dayKeyFromTs(ts) {
  const d = new Date(n(ts, Date.now()));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function buildTradeId(system, id, symbol, entryAt) {
  if (id) return `${system}:${id}`;
  return `${system}:${up(symbol)}:${n(entryAt, Date.now())}`;
}

function pickWinTags(trade) {
  const tags = [];
  if (n(trade.pnlPct, 0) <= 0) return tags;

  if (n(trade.spreadAtOpen, 999) <= 0.35) tags.push("tight_spread");
  if (n(trade.depthAtOpen, 0) >= 10000) tags.push("high_depth");
  if (n(trade.obScoreAtOpen, 0) >= 0.03) tags.push("strong_orderbook");
  if (n(trade.entryQuality, 0) >= 75) tags.push("high_entry_quality");
  if (n(trade.persistenceScore, 0) >= 70) tags.push("high_persistence");
  if (String(trade.regime || "").toUpperCase() === "TREND") tags.push("trend_alignment");
  if (String(trade.exitReason || "").toLowerCase() === "tp") tags.push("tp_hit");
  if (n(trade.holdMinutes, 0) <= 180 && n(trade.pnlPct, 0) > 0) tags.push("fast_winner");

  return tags;
}

function pickLossTags(trade) {
  const tags = [];
  if (n(trade.pnlPct, 0) >= 0) return tags;

  if (n(trade.spreadAtOpen, 0) > 0.9) tags.push("wide_spread_entry");
  if (n(trade.depthAtOpen, 0) > 0 && n(trade.depthAtOpen, 0) < 2500) tags.push("low_depth");
  if (n(trade.obScoreAtOpen, 0) <= -0.02) tags.push("bad_orderbook_bias");
  if (n(trade.entryQuality, 0) < 60) tags.push("low_entry_quality");
  if (n(trade.persistenceScore, 0) < 55) tags.push("low_persistence");
  if (String(trade.exitReason || "").toLowerCase() === "sl") tags.push("stop_loss");
  if (String(trade.exitReason || "").toLowerCase() === "timeout") tags.push("timeout_no_followthrough");
  if (String(trade.exitReason || "").toLowerCase().includes("spread")) tags.push("spread_problem");
  if (String(trade.regime || "").toUpperCase() === "CHOP") tags.push("choppy_regime");

  return tags;
}

function buildReasonSummary(trade) {
  const pnl = n(trade.pnlPct, 0);
  const exitReason = String(trade.exitReason || "unknown").toLowerCase();

  if (pnl > 0) {
    if (exitReason === "tp") return "winner_take_profit";
    return "winner_manual_or_structural_exit";
  }

  if (exitReason === "sl") return "loser_stop_loss";
  if (exitReason === "timeout") return "loser_timeout";
  if (exitReason === "emergency") return "loser_emergency_exit";
  if (exitReason.includes("spread")) return "loser_spread_issue";
  if (exitReason.includes("ob")) return "loser_orderbook_break";
  if (exitReason.includes("sell_break") || exitReason.includes("hard_break")) return "loser_structure_break";

  return pnl < 0 ? "loser_other" : "neutral_other";
}

function summarizeTrades(trades) {
  const arr = safeArr(trades);
  const total = arr.length;
  const wins = arr.filter(t => n(t.pnlPct, 0) > 0);
  const losses = arr.filter(t => n(t.pnlPct, 0) < 0);
  const pnlPctSum = arr.reduce((a, t) => a + n(t.pnlPct, 0), 0);
  const pnlUsdSum = arr.reduce((a, t) => a + n(t.pnlUsd, 0), 0);
  const grossWin = wins.reduce((a, t) => a + Math.max(0, n(t.pnlUsd, 0)), 0);
  const grossLoss = losses.reduce((a, t) => a + Math.abs(Math.min(0, n(t.pnlUsd, 0))), 0);

  return {
    total,
    wins: wins.length,
    losses: losses.length,
    breakeven: total - wins.length - losses.length,
    winRatePct: total > 0 ? Number(((wins.length / total) * 100).toFixed(2)) : 0,
    pnlPctSum: Number(pnlPctSum.toFixed(4)),
    pnlUsdSum: Number(pnlUsdSum.toFixed(4)),
    avgPnlPct: total > 0 ? Number((pnlPctSum / total).toFixed(4)) : 0,
    avgWinPct: wins.length > 0 ? Number((wins.reduce((a, t) => a + n(t.pnlPct, 0), 0) / wins.length).toFixed(4)) : 0,
    avgLossPct: losses.length > 0 ? Number((losses.reduce((a, t) => a + n(t.pnlPct, 0), 0) / losses.length).toFixed(4)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(4)) : grossWin > 0 ? 999 : 0,
  };
}

function bucketBy(arr, keyFn) {
  const out = {};
  for (const item of safeArr(arr)) {
    const k = keyFn(item) || "UNKNOWN";
    if (!out[k]) out[k] = [];
    out[k].push(item);
  }
  return out;
}

async function writeDailySummary(dayKey) {
  const closed = safeArr(await kv.get(`analytics:closed:day:${dayKey}`));
  const summary = summarizeTrades(closed);

  const bySystem = bucketBy(closed, t => up(t.system));
  const byRegime = bucketBy(closed, t => up(t.regime));
  const bySide = bucketBy(closed, t => up(t.side));
  const byExit = bucketBy(closed, t => String(t.exitReason || "unknown").toLowerCase());

  const mapSummary = (obj) =>
    Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [k, summarizeTrades(v)])
    );

  const topLossTags = {};
  const topWinTags = {};

  for (const t of closed) {
    for (const tag of safeArr(t.lossTags)) topLossTags[tag] = (topLossTags[tag] || 0) + 1;
    for (const tag of safeArr(t.winTags)) topWinTags[tag] = (topWinTags[tag] || 0) + 1;
  }

  const payload = {
    day: dayKey,
    updatedAt: Date.now(),
    summary,
    bySystem: mapSummary(bySystem),
    byRegime: mapSummary(byRegime),
    bySide: mapSummary(bySide),
    byExit: mapSummary(byExit),
    topLossTags,
    topWinTags,
  };

  await kv.set(`analytics:summary:day:${dayKey}`, payload, { ex: 60 * 60 * 24 * 60 });
  return payload;
}

export async function logTradeOpened({
  system,
  tradeId,
  symbol,
  mode,
  side,
  entryAt,
  entryPrice,
  sizeUsd,
  tp,
  sl,
  rr,
  tpPct,
  slPct,
  scannerStageAtOpen,
  engineGateAtOpen,
  entryQuality,
  persistenceScore,
  qualityScore,
  timingScore,
  marketScore,
  perfectCandidateScore,
  spreadAtOpen,
  obScoreAtOpen,
  depthAtOpen,
  btcState,
  regime,
  meta = {},
}) {
  const id = buildTradeId(system, tradeId, symbol, entryAt);
  const payload = {
    id,
    system: String(system || "unknown").toLowerCase(),
    symbol: up(symbol),
    mode: String(mode || "bull").toLowerCase(),
    side: up(side),
    entryAt: n(entryAt, Date.now()),
    entryPrice: n(entryPrice, 0),
    sizeUsd: n(sizeUsd, 0),
    tp: n(tp, 0),
    sl: n(sl, 0),
    rr: n(rr, 0),
    tpPct: n(tpPct, 0),
    slPct: n(slPct, 0),
    scannerStageAtOpen: up(scannerStageAtOpen),
    engineGateAtOpen: up(engineGateAtOpen),
    entryQuality: n(entryQuality, 0),
    persistenceScore: n(persistenceScore, 0),
    qualityScore: n(qualityScore, 0),
    timingScore: n(timingScore, 0),
    marketScore: n(marketScore, 0),
    perfectCandidateScore: n(perfectCandidateScore, 0),
    spreadAtOpen: n(spreadAtOpen, 999),
    obScoreAtOpen: n(obScoreAtOpen, 0),
    depthAtOpen: n(depthAtOpen, 0),
    btcState: up(btcState || "NEUTRAL"),
    regime: String(regime || "").toUpperCase(),
    meta,
    closed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  await kv.set(`analytics:trade:${id}`, payload, { ex: 60 * 60 * 24 * 90 });

  const openDayKey = dayKeyFromTs(payload.entryAt);
  const openIdsKey = `analytics:opened:day:${openDayKey}`;
  const prev = safeArr(await kv.get(openIdsKey));
  if (!prev.includes(id)) {
    await kv.set(openIdsKey, [id, ...prev].slice(0, 5000), { ex: 60 * 60 * 24 * 90 });
  }

  return payload;
}

export async function logTradeClosed({
  system,
  tradeId,
  symbol,
  exitAt,
  exitPrice,
  pnlPct,
  pnlUsd,
  exitReason,
  maxPnlPct = null,
  minPnlPct = null,
  extra = {},
}) {
  const fallbackId = buildTradeId(system, tradeId, symbol, extra?.entryAt || 0);
  const id = tradeId ? buildTradeId(system, tradeId, symbol, extra?.entryAt || 0) : fallbackId;

  const existing = (await kv.get(`analytics:trade:${id}`)) || {
    id,
    system: String(system || "unknown").toLowerCase(),
    symbol: up(symbol),
  };

  const closedTrade = {
    ...existing,
    exitAt: n(exitAt, Date.now()),
    exitPrice: n(exitPrice, 0),
    pnlPct: n(pnlPct, 0),
    pnlUsd: n(pnlUsd, 0),
    exitReason: String(exitReason || "unknown").toLowerCase(),
    maxPnlPct: maxPnlPct == null ? null : n(maxPnlPct, 0),
    minPnlPct: minPnlPct == null ? null : n(minPnlPct, 0),
    holdMinutes:
      n(existing.entryAt, 0) > 0
        ? Number(((n(exitAt, Date.now()) - n(existing.entryAt, 0)) / 60000).toFixed(2))
        : 0,
    closed: true,
    updatedAt: Date.now(),
    ...extra,
  };

  closedTrade.winTags = pickWinTags(closedTrade);
  closedTrade.lossTags = pickLossTags(closedTrade);
  closedTrade.reasonSummary = buildReasonSummary(closedTrade);

  await kv.set(`analytics:trade:${id}`, closedTrade, { ex: 60 * 60 * 24 * 180 });

  const closeDayKey = dayKeyFromTs(closedTrade.exitAt);
  const dayClosedKey = `analytics:closed:day:${closeDayKey}`;
  const prevClosed = safeArr(await kv.get(dayClosedKey));

  const filtered = prevClosed.filter(t => String(t?.id || "") !== id);
  const nextClosed = [closedTrade, ...filtered].slice(0, 5000);

  await kv.set(dayClosedKey, nextClosed, { ex: 60 * 60 * 24 * 180 });
  await writeDailySummary(closeDayKey);

  return closedTrade;
}

export async function getDailySummary(dayKey) {
  const key = String(dayKey || dayKeyFromTs(Date.now()));
  const existing = await kv.get(`analytics:summary:day:${key}`);
  if (existing) return existing;
  return await writeDailySummary(key);
}

export async function getRecentClosedTrades(limit = 100) {
  const days = [];
  const now = Date.now();
  for (let i = 0; i < 14; i++) {
    days.push(dayKeyFromTs(now - i * 86400000));
  }

  let all = [];
  for (const d of days) {
    const arr = safeArr(await kv.get(`analytics:closed:day:${d}`));
    all = all.concat(arr);
    if (all.length >= limit) break;
  }

  all.sort((a, b) => n(b.exitAt, 0) - n(a.exitAt, 0));
  return all.slice(0, limit);
}

export async function getGlobalSummary(daysBack = 14) {
  const trades = [];
  const now = Date.now();

  for (let i = 0; i < daysBack; i++) {
    const day = dayKeyFromTs(now - i * 86400000);
    const arr = safeArr(await kv.get(`analytics:closed:day:${day}`));
    trades.push(...arr);
  }

  const summary = summarizeTrades(trades);
  const bySystem = Object.fromEntries(
    Object.entries(bucketBy(trades, t => up(t.system))).map(([k, v]) => [k, summarizeTrades(v)])
  );
  const byRegime = Object.fromEntries(
    Object.entries(bucketBy(trades, t => up(t.regime))).map(([k, v]) => [k, summarizeTrades(v)])
  );
  const byExit = Object.fromEntries(
    Object.entries(bucketBy(trades, t => String(t.exitReason || "unknown").toLowerCase())).map(([k, v]) => [k, summarizeTrades(v)])
  );

  return {
    daysBack,
    updatedAt: Date.now(),
    summary,
    bySystem,
    byRegime,
    byExit,
  };
}