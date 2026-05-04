// lib/stageMemory.js

import {
  loadStageMemoryFromStore,
  saveStageMemoryToStore,
  getStageMemory,
  setStageMemory
} from "./scanStore.js";

const VALID_STAGES = ["radar", "buildup", "almost", "entry"];
const MAX_MEMORY_AGE_MS = 48 * 60 * 60 * 1000;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeStage(stage, fallback = "radar") {
  const s = String(stage || "").toLowerCase();
  return VALID_STAGES.includes(s) ? s : fallback;
}

function normalizeSymbol(symbol) {
  return String(symbol || "")
    .toUpperCase()
    .trim()
    .replace(/USDT$/, "")
    .replace(/USDC$/, "");
}

function normalizeKey(key) {
  const parts = String(key || "").split("_");
  const symbol = normalizeSymbol(parts[0]);
  const side = String(parts[1] || "bull").toLowerCase() === "bear" ? "bear" : "bull";

  if (!symbol) return "";

  return `${symbol}_${side}`;
}

function normalizeMemory(memory = {}) {
  const now = Date.now();
  const out = {};

  for (const [rawKey, value] of Object.entries(memory || {})) {
    const key = normalizeKey(rawKey);
    if (!key || !value || typeof value !== "object") continue;

    out[key] = {
      stage: safeStage(value.stage),
      prevStage: safeStage(value.prevStage),
      entryType: typeof value.entryType === "string" ? value.entryType : null,
      flow: typeof value.flow === "string" ? value.flow : null,
      score: safeNumber(value.score, 0),
      runnerPressure: safeNumber(value.runnerPressure, 0),
      runnerAcceleration: safeNumber(value.runnerAcceleration, 0),
      updatedAt: safeNumber(value.updatedAt || value.ts, now)
    };
  }

  return out;
}

// ================= LOAD =================
export async function loadStageMemory() {
  try {
    const data = await loadStageMemoryFromStore();
    return normalizeMemory(data || {});
  } catch (e) {
    console.error("RUNNER LOAD MEMORY ERROR:", e?.message || e);
    return normalizeMemory(getStageMemory() || {});
  }
}

// ================= SAVE =================
export async function saveStageMemory(memory) {
  try {
    const normalized = normalizeMemory(memory || {});
    await saveStageMemoryToStore(normalized);
    return normalized;
  } catch (e) {
    console.error("RUNNER SAVE MEMORY ERROR:", e?.message || e);

    const normalized = normalizeMemory(memory || {});
    setStageMemory(normalized);

    return normalized;
  }
}

// ================= CLEAN =================
export function cleanMemory(memory, activeSymbols = []) {
  const normalized = normalizeMemory(memory || {});
  const active = new Set(
    (Array.isArray(activeSymbols) ? activeSymbols : [])
      .map(normalizeSymbol)
      .filter(Boolean)
  );

  const now = Date.now();
  const cleaned = {};

  for (const [key, value] of Object.entries(normalized)) {
    const symbol = normalizeSymbol(key.split("_")[0]);
    if (!symbol) continue;
    if (active.size > 0 && !active.has(symbol)) continue;

    const age = now - safeNumber(value.updatedAt, now);
    if (age > MAX_MEMORY_AGE_MS) continue;

    cleaned[key] = value;
  }

  return cleaned;
}

export function updateStageMemoryEntry(memory, coin) {
  const normalized = normalizeMemory(memory || {});
  const symbol = normalizeSymbol(coin?.symbol);
  const side = String(coin?.side || "bull").toLowerCase() === "bear" ? "bear" : "bull";

  if (!symbol) return normalized;

  const key = `${symbol}_${side}`;
  const prev = normalized[key] || {};

  normalized[key] = {
    stage: safeStage(coin?.stage),
    prevStage: safeStage(prev.stage || coin?.prevStage),
    entryType: typeof coin?.entryType === "string" ? coin.entryType : prev.entryType || null,
    flow: typeof coin?.flow === "string" ? coin.flow : prev.flow || null,
    score: safeNumber(coin?.moveScore ?? coin?.score, prev.score || 0),
    runnerPressure: safeNumber(coin?.runnerPressure, prev.runnerPressure || 0),
    runnerAcceleration: safeNumber(coin?.runnerAcceleration, prev.runnerAcceleration || 0),
    updatedAt: Date.now()
  };

  return normalized;
}