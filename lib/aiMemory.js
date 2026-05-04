// lib/aiMemory.js

const MAX_MEMORY_TRADES = 2_000;

function createSideStats() {
  return {
    win: 0,
    loss: 0,
    wait: 0,
    entry: 0
  };
}

function createMemory() {
  return {
    profile: "RUNNER",
    trades: [],
    stats: {
      bull: createSideStats(),
      bear: createSideStats()
    },
    byEntryType: {},
    byFlow: {},
    updatedAt: Date.now()
  };
}

function getMemory() {
  if (!globalThis.__RUNNER_AI_MEMORY__) {
    globalThis.__RUNNER_AI_MEMORY__ = createMemory();
  }

  return globalThis.__RUNNER_AI_MEMORY__;
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

function normalizeResult(result) {
  const r = String(result || "").toUpperCase();

  if (r === "WIN") return "WIN";
  if (r === "LOSS") return "LOSS";
  if (r === "ENTRY") return "ENTRY";
  if (r === "WAIT") return "WAIT";

  return "UNKNOWN";
}

function incrementMapCounter(map, key) {
  const k = String(key || "UNKNOWN").toUpperCase();
  map[k] = (map[k] || 0) + 1;
}

export function logAITrade(trade) {
  const memory = getMemory();

  const side = normalizeSide(trade?.side);
  const result = normalizeResult(trade?.result || trade?.action);

  const normalized = {
    ...trade,
    side,
    result,
    runnerProfile: trade?.runnerProfile || "RUNNER",
    loggedAt: Date.now()
  };

  memory.trades.push(normalized);

  if (memory.trades.length > MAX_MEMORY_TRADES) {
    memory.trades = memory.trades.slice(-MAX_MEMORY_TRADES);
  }

  if (result === "WIN") memory.stats[side].win++;
  if (result === "LOSS") memory.stats[side].loss++;
  if (result === "WAIT") memory.stats[side].wait++;
  if (result === "ENTRY") memory.stats[side].entry++;

  incrementMapCounter(memory.byEntryType, trade?.entryType || trade?.sniper || "UNKNOWN");
  incrementMapCounter(memory.byFlow, trade?.flow || "UNKNOWN");

  memory.updatedAt = Date.now();
}

export function getAIStats() {
  const memory = getMemory();

  return {
    profile: memory.profile,
    stats: memory.stats,
    byEntryType: memory.byEntryType,
    byFlow: memory.byFlow,
    totalTrades: memory.trades.length,
    updatedAt: memory.updatedAt
  };
}

export function getAITrades(limit = 250) {
  const memory = getMemory();
  const n = Math.max(1, Math.min(Number(limit) || 250, MAX_MEMORY_TRADES));

  return memory.trades.slice(-n);
}

export function getWinrate(side) {
  const memory = getMemory();
  const s = memory.stats[normalizeSide(side)];

  const total = s.win + s.loss;

  if (total === 0) return 50;

  return (s.win / total) * 100;
}

export function resetAIMemory() {
  globalThis.__RUNNER_AI_MEMORY__ = createMemory();

  return getAIStats();
}