function getPriorityScore(item) {
  let base = 0;
  if (item.sourceSystem === "moon") {
    if (item.stage.includes("ELITE")) base = 1000;
    else if (item.stage === "ALMOST") base = 600;
  } else {
    if (item.stage === "ENTRY_READY") base = 800;
    else if (item.stage === "SETUP") base = 400;
  }
  return base + (item.perfectCandidateScore || item.confidence || 0);
}

export function resolveFunnelConflicts(items, now) {
  const grouped = new Map();
  const MAX_AGE_MS = 6 * 60 * 1000;
  for (const item of items) {
    if (now - item.queuedAt > MAX_AGE_MS) continue;
    if (!grouped.has(item.symbol)) grouped.set(item.symbol,);
    grouped.get(item.symbol).push(item);
  }
  const resolved =;
  for (const [sym, candidates] of grouped.entries()) {
    if (candidates.length === 1) { resolved.push(candidates); continue; }
    const sides = new Set(candidates.map(c => c.side));
    if (sides.size > 1) {
      console.warn(`Conflict: Long & Short intenties voor ${sym}. Beiden geblokkeerd.`);
      continue;
    }
    candidates.sort((a, b) => getPriorityScore(b) - getPriorityScore(a));
    resolved.push(candidates);
  }
  return resolved;
}

export function computeFunnelGate(item) {
  if (!item.tradePlan) return "IGNORE";
  if (item.sourceSystem === "moon") {
    if (item.stage.includes("ELITE")) return "OPEN";
    if (item.stage === "ALMOST" && item.entryQuality >= 60) return "WATCH";
  } else {
    if (item.stage === "ENTRY_READY") return "WATCH";
  }
  return "IGNORE";
}

export function entryTriggerOk({ side, price, entry, spreadPct, maxSpreadPct, obScore }) {
  if (!price ||!entry || spreadPct > maxSpreadPct) return false;
  const distPct = Math.abs((price - entry) / entry) * 100;
  if (distPct > 1.25) return false;
  if (side === "SHORT" && obScore > -0.01) return false;
  if (side === "LONG" && obScore < 0.01) return false;
  return true;
}

export function hardBreakDetected({ side, obScore, spreadPct, obContraExtremeAbs, maxSpreadPctInTrade }) {
  if (spreadPct > maxSpreadPctInTrade) return { hit: true, reason: "spread_spike" };
  if (side === "SHORT" && obScore >= obContraExtremeAbs) return { hit: true, reason: "hard_break" };
  if (side === "LONG" && obScore <= -obContraExtremeAbs) return { hit: true, reason: "hard_break" };
  return { hit: false, reason: "" };
}

export default { resolveFunnelConflicts, computeFunnelGate, entryTriggerOk, hardBreakDetected };
