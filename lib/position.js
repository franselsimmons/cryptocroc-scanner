// lib/position.js

const positions = new Map();

function normalizeKey(symbol, side = "") {
  const s = String(symbol || "UNKNOWN")
    .toUpperCase()
    .replace(/USDT$/, "");

  const normalizedSide = String(side || "").toLowerCase();

  return normalizedSide
    ? `${s}_${normalizedSide}`
    : s;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function openPosition(symbol, price, options = {}) {
  const side = String(options.side || "bull").toLowerCase();
  const key = normalizeKey(symbol, side);

  const entry = safeNumber(price, 0);

  positions.set(key, {
    key,
    symbol: String(symbol || "UNKNOWN").toUpperCase(),
    side,

    entry,
    avgEntry: entry,
    price: entry,

    size: safeNumber(options.size, 1),
    adds: 0,

    sl: safeNumber(options.sl, 0),
    tp: safeNumber(options.tp, 0),
    rr: safeNumber(options.rr, 0),

    state: "OPEN",
    runnerProfile: "RUNNER",
    entryType: options.entryType || "RUNNER_UNCLASSIFIED",

    partialTaken: false,
    movedToBE: false,
    trailActive: false,
    trailPrice: 0,

    highestPrice: side === "bull" ? entry : 0,
    lowestPrice: side === "bear" ? entry : 0,

    created: Date.now(),
    updatedAt: Date.now()
  });

  return positions.get(key);
}

export function addPosition(symbol, price, options = {}) {
  const side = String(options.side || "bull").toLowerCase();
  const key = normalizeKey(symbol, side);
  const p = positions.get(key);

  if (!p) return null;

  const addSize = safeNumber(options.size, 0.5);
  const addPrice = safeNumber(price, p.avgEntry);

  const newSize = p.size + addSize;
  const newAvg = newSize > 0
    ? ((p.avgEntry * p.size) + (addPrice * addSize)) / newSize
    : p.avgEntry;

  p.size = newSize;
  p.avgEntry = newAvg;
  p.adds += 1;
  p.lastAdd = addPrice;
  p.price = addPrice;
  p.updatedAt = Date.now();

  return p;
}

export function updatePosition(symbol, patch = {}, side = "") {
  const key = normalizeKey(symbol, side || patch.side);
  const p = positions.get(key);

  if (!p) return null;

  Object.assign(p, patch, {
    updatedAt: Date.now()
  });

  return p;
}

export function closePosition(symbol, side = "") {
  if (side) {
    const key = normalizeKey(symbol, side);
    const existing = positions.get(key);
    positions.delete(key);
    return existing || null;
  }

  const base = normalizeKey(symbol);
  let closed = null;

  for (const [key, value] of positions.entries()) {
    if (key.startsWith(`${base}_`) || key === base) {
      closed = value;
      positions.delete(key);
    }
  }

  return closed;
}

export function getPosition(symbol, side = "") {
  if (side) return positions.get(normalizeKey(symbol, side));

  const base = normalizeKey(symbol);

  for (const [key, value] of positions.entries()) {
    if (key.startsWith(`${base}_`) || key === base) {
      return value;
    }
  }

  return null;
}

export function getAllPositions() {
  return Array.from(positions.values());
}

export function clearPositions() {
  positions.clear();

  return {
    ok: true,
    profile: "RUNNER",
    clearedAt: Date.now()
  };
}