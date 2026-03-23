// lib/_adaptive.js
// Adaptieve thresholds op basis van regime en performance

export function getAdaptiveThreshold({ base, regime, performance, min = 0, max = 100 }) {
  let adj = 0;

  const r = String(regime || "").toUpperCase();
  if (r === "EXPANSION") adj += 3;
  if (r === "TRENDING") adj += 1;
  if (r === "CHOPPY") adj -= 2;
  if (r === "HEADWIND") adj -= 4;
  if (r === "DRY") adj -= 3;

  // Performance feedback
  if (performance?.winRate >= 60) adj += 2;
  if (performance?.winRate <= 40) adj -= 3;

  // Drawdown bescherming
  if (performance?.drawdown >= 8) adj -= 4;

  // max +/-5
  adj = Math.min(5, Math.max(-5, adj));

  let result = base + adj;
  result = Math.max(min, result);
  result = Math.min(max, result);

  return Math.round(result);
}

export function getAdaptivePositionSize({ baseSize, performance }) {
  if (!performance) return baseSize;

  if (performance.winRate >= 60) return Math.round(baseSize * 1.2);
  if (performance.winRate <= 40) return Math.round(baseSize * 0.7);

  return baseSize;
}