// lib/_adaptive.js

export function getAdaptiveThreshold({ base, regime, performance, min = 0, max = 100 }) {
  let adj = 0;

  const r = String(regime || "").toUpperCase();
  if (r === "EXPANSION") adj += 3;
  if (r === "TRENDING") adj += 1;
  if (r === "CHOPPY") adj -= 2;
  if (r === "HEADWIND") adj -= 4;
  if (r === "DRY") adj -= 3;

  const winRate = Number(performance?.winRate ?? 50);
  const drawdown = Number(performance?.drawdown ?? 0);

  if (winRate >= 60) adj += 2;
  if (winRate <= 40) adj -= 3;

  if (drawdown >= 8) adj -= 4;

  adj = Math.min(5, Math.max(-5, adj));

  let result = Number(base || 0) + adj;
  result = Math.max(min, Math.min(max, result));
  return Math.round(result);
}

export function getAdaptivePositionSize({ baseSize, performance }) {
  const base = Number(baseSize || 0);
  if (!performance) return base;

  const winRate = Number(performance?.winRate ?? 50);

  if (winRate >= 60) return Math.round(base * 1.2);
  if (winRate <= 40) return Math.round(base * 0.7);
  return base;
}