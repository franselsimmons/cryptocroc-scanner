export function entryTriggerOk({
  side,
  price,
  entry,
  spreadPct,
  maxSpreadPct,
  obScore
}) {
  if (spreadPct > maxSpreadPct) return false;

  if (side === "LONG") {
    return price >= entry && obScore > 0;
  } else {
    return price <= entry && obScore < 0;
  }
}

export function hardBreakDetected({ side, obScore }) {
  if (side === "LONG" && obScore < -0.05) {
    return { hit: true, reason: "hard_break" };
  }

  if (side === "SHORT" && obScore > 0.05) {
    return { hit: true, reason: "hard_break" };
  }

  return { hit: false };
}