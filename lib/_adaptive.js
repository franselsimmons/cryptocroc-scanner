// lib/_adaptive.js
// Adaptieve thresholds op basis van regime en performance

/**
 * Past een drempel aan op basis van regime en performance.
 * @param {Object} params
 * @param {number} params.base - de basis drempel uit THRESHOLDS
 * @param {string} params.regime - marktregime (EXPANSION, TRENDING, CHOPPY, HEADWIND, DRY)
 * @param {Object} params.performance - performance data (winRate, drawdown)
 * @param {number} params.min - minimale waarde (optioneel)
 * @param {number} params.max - maximale waarde (optioneel)
 * @returns {number} aangepaste drempel
 */
export function getAdaptiveThreshold({ base, regime, performance, min = 0, max = 100 }) {
  let adj = 0;

  // 1. Regime aanpassing
  const r = (regime || "").toUpperCase();
  if (r === "EXPANSION") adj += 3;
  if (r === "TRENDING") adj += 1;
  if (r === "CHOPPY") adj -= 2;
  if (r === "HEADWIND") adj -= 4;
  if (r === "DRY") adj -= 3;

  // 2. Performance feedback (winrate)
  if (performance?.winRate >= 60) adj += 2;
  if (performance?.winRate <= 40) adj -= 3;

  // 3. Drawdown bescherming
  if (performance?.drawdown >= 8) adj -= 4;

  // Begrenzing: max +/-5 aanpassing
  adj = Math.min(5, Math.max(-5, adj));

  let result = base + adj;

  // Resultaat binnen min/max houden
  if (min !== undefined) result = Math.max(min, result);
  if (max !== undefined) result = Math.min(max, result);

  return Math.round(result);
}

/**
 * Berekent dynamische position size op basis van winrate.
 * @param {number} baseSize - basis grootte (bijv. 50 USD)
 * @param {Object} performance - performance data (winRate)
 * @returns {number} aangepaste size
 */
export function getAdaptivePositionSize({ baseSize, performance }) {
  if (!performance) return baseSize;

  if (performance.winRate >= 60) return Math.round(baseSize * 1.2);
  if (performance.winRate <= 40) return Math.round(baseSize * 0.7);

  return baseSize;
}