import {
  openPosition,
  addPosition,
  closePosition,
  getPosition,
  getAllPositions,
  updatePosition
} from "./position.js";

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

export function handleEntry(c) {
  const side = normalizeSide(c?.side);

  if (getPosition(c.symbol, side)) return null;

  return openPosition(c.symbol, c.price || c.entry, {
    side,
    size: c.size || 1,
    sl: c.sl,
    tp: c.tp,
    rr: c.rr,
    entryType: c.entryType || c.runnerEntryType,
    runnerProfile: "RUNNER"
  });
}

export function handleAdd(c) {
  return addPosition(c.symbol, c.price || c.entry, {
    side: normalizeSide(c?.side),
    size: c.addSize || 0.5
  });
}

export function handleTrail(c) {
  const side = normalizeSide(c?.side);
  const pos = getPosition(c.symbol, side);

  if (!pos) return null;

  const price = safeNumber(c?.price, pos.price);

  if (side === "bull") {
    pos.highestPrice = Math.max(safeNumber(pos.highestPrice, price), price);
  } else {
    pos.lowestPrice = pos.lowestPrice
      ? Math.min(safeNumber(pos.lowestPrice, price), price)
      : price;
  }

  return updatePosition(c.symbol, {
    price,
    trailActive: Boolean(c.trailActive ?? pos.trailActive),
    trailPrice: safeNumber(c.trailPrice, pos.trailPrice),
    highestPrice: pos.highestPrice,
    lowestPrice: pos.lowestPrice
  }, side);
}

export function handlePartialTp(c) {
  const side = normalizeSide(c?.side);

  return updatePosition(c.symbol, {
    partialTaken: true,
    lastPartialPrice: safeNumber(c.price || c.tp),
    updatedAt: Date.now()
  }, side);
}

export function handleMoveToBE(c) {
  const side = normalizeSide(c?.side);
  const pos = getPosition(c.symbol, side);

  if (!pos) return null;

  return updatePosition(c.symbol, {
    movedToBE: true,
    sl: pos.avgEntry || pos.entry,
    updatedAt: Date.now()
  }, side);
}

export function handleExit(c) {
  return closePosition(c.symbol, normalizeSide(c?.side));
}

export function getPositions() {
  return getAllPositions();
}