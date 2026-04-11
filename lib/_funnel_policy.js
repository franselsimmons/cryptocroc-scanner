// lib/_funnel_policy.js

function getPriorityScore(item) {
  let base = 0;
  if (item.sourceSystem === "moon") {
    if (item.stage.includes("ELITE")) base = 1000;
    else if (item.stage === "ALMOST") base = 600;
  } else {
    if (item.stage === "ENTRY_READY") base = 800;
    else if (item.stage === "SETUP") base = 400;
  }
  return base + (item.perfectCandidateScore |

| item.confidence |
| 0);
}

export function resolveFunnelConflicts(items, now) {
  const grouped = new Map();
  const MAX_AGE_MS = 6 * 60 * 1000; // 6 minuten freshness check

  for (const item of items) {
    if (now - item.queuedAt > MAX_AGE_MS) continue; 
    if (!grouped.has(item.symbol)) grouped.set(item.symbol,);
    grouped.get(item.symbol).push(item);
  }

  const resolved =;
  
  for (const [sym, candidates] of grouped.entries()) {
    if (candidates.length === 1) {
      resolved.push(candidates);
      continue;
    }

    // Identificeer tegengestelde richtingen
    const sides = new Set(candidates.map(c => c.side));
    if (sides.size > 1) {
      console.warn(`[Funnel] Conflict: Long en Short signaal voor ${sym}. Beide geblokkeerd.`);
      continue; 
    }

    // Hoogste prioriteit wint bij gelijke richting
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
