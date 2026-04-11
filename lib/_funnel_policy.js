function score(item) {
  let base = 0;

  if (item.sourceSystem === "moon") {
    if (item.stage.includes("ELITE")) base = 1000;
    else if (item.stage === "ALMOST") base = 600;
  } else {
    if (item.stage === "ENTRY_READY") base = 800;
  }

  return base + (item.confidence || 0);
}

export function resolveFunnelConflicts(items, now) {
  const grouped = new Map();

  for (const item of items) {
    if (!grouped.has(item.symbol)) grouped.set(item.symbol, []);
    grouped.get(item.symbol).push(item);
  }

  const result = [];

  for (const [sym, arr] of grouped.entries()) {
    if (arr.length === 1) {
      result.push(arr[0]);
      continue;
    }

    const sides = new Set(arr.map(x => x.side || x.sourceMode));

    if (sides.size > 1) continue;

    arr.sort((a, b) => score(b) - score(a));
    result.push(arr[0]);
  }

  return result;
}

export function computeDeskGate(item) {
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