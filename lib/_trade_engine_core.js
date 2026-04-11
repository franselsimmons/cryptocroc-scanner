function score(item) {
  let base = 0;
  if (item.sourceSystem === "moon") {
    if (item.stage.includes("ELITE")) base = 1000;
    else if (item.stage === "ALMOST") base = 600;
  } else {
    if (item.stage === "ENTRY_READY") base = 800;
    else if (item.stage === "SETUP") base = 400;
  }
  return base + (item.confidence || 0);
}

export function resolveFunnelConflicts(items, now) {
  const grouped = new Map();
  for (const i of items) {
    if (!grouped.has(i.symbol)) grouped.set(i.symbol, []);
    grouped.get(i.symbol).push(i);
  }

  const out = [];
  for (const [, arr] of grouped) {
    if (arr.length === 1) {
      out.push(arr[0]);
      continue;
    }

    const sides = new Set(arr.map(x => x.side));
    if (sides.size > 1) continue;

    arr.sort((a, b) => score(b) - score(a));
    out.push(arr[0]);
  }

  return out;
}

export function computeFunnelGate(item) {
  if (!item.tradePlan) return "IGNORE";

  if (item.sourceSystem === "moon") {
    if (item.stage.includes("ELITE")) return "OPEN";
    if (item.stage === "ALMOST") return "WATCH";
  }

  if (item.sourceSystem === "main") {
    if (item.stage === "ENTRY_READY") return "WATCH";
  }

  return "IGNORE";
}

export function entryTriggerOk({ price, entry, spreadPct }) {
  if (!price || !entry) return false;
  if (spreadPct > 1.25) return false;

  const dist = Math.abs((price - entry) / entry) * 100;
  return dist < 1.25;
}

export function hardBreakDetected({ spreadPct }) {
  if (spreadPct > 1.5) return { hit: true, reason: "spread_spike" };
  return { hit: false };
}