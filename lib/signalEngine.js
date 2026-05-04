// lib/signalEngine.js

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function normalizeAction(action) {
  return safeString(action, "UNKNOWN").toUpperCase();
}

function normalizeSide(side) {
  return safeString(side, "bull").toLowerCase() === "bear" ? "bear" : "bull";
}

function baseSignal(t, signal) {
  return {
    profile: "RUNNER",
    symbol: safeString(t?.symbol, "UNKNOWN").toUpperCase(),
    side: normalizeSide(t?.side),
    signal,
    action: normalizeAction(t?.action),

    entryType: safeString(t?.entryType || t?.runnerEntryType, "RUNNER_UNCLASSIFIED"),
    flow: safeString(t?.flow, "N/A"),
    grade: safeString(t?.grade, "N/A"),

    reason: safeString(t?.reason, "N/A"),

    score: safeNumber(t?.score ?? t?.moveScore),
    confluence: safeNumber(t?.confluence),
    rr: safeNumber(t?.rr),

    runnerPressure: safeNumber(t?.runnerPressure),
    runnerAcceleration: safeNumber(t?.runnerAcceleration),
    freshness: safeNumber(t?.freshness),

    timestamp: Date.now()
  };
}

function entrySignal(t) {
  return {
    ...baseSignal(t, "ENTRY"),

    entry: safeNumber(t?.entry),
    sl: safeNumber(t?.sl),
    tp: safeNumber(t?.tp),

    partialTp: safeNumber(t?.partialTp),
    breakevenAt: safeNumber(t?.breakevenAt),
    trailStart: safeNumber(t?.trailStart),

    copy: {
      entry: safeNumber(t?.entry),
      sl: safeNumber(t?.sl),
      tp: safeNumber(t?.tp)
    }
  };
}

function addSignal(t) {
  return {
    ...baseSignal(t, "ADD"),
    price: safeNumber(t?.price ?? t?.entry),
    addSize: safeNumber(t?.addSize, 0.5),
    reason: safeString(t?.reason, "Runner continuation add")
  };
}

function partialSignal(t) {
  return {
    ...baseSignal(t, "PARTIAL_TP"),
    price: safeNumber(t?.price ?? t?.partialTp ?? t?.tp),
    reason: safeString(t?.reason, "Secure partial profit")
  };
}

function moveBeSignal(t) {
  return {
    ...baseSignal(t, "MOVE_BE"),
    price: safeNumber(t?.price),
    newSl: safeNumber(t?.newSl ?? t?.entry),
    reason: safeString(t?.reason, "Move SL to breakeven")
  };
}

function trailSignal(t) {
  return {
    ...baseSignal(t, "TRAIL"),
    price: safeNumber(t?.price),
    trailPrice: safeNumber(t?.trailPrice),
    reason: safeString(t?.reason, "Runner trailing active")
  };
}

function exitSignal(t) {
  return {
    ...baseSignal(t, "EXIT"),
    price: safeNumber(t?.price ?? t?.exit),
    exit: safeNumber(t?.exit ?? t?.price),
    pnlPct: safeNumber(t?.pnlPct),
    reason: safeString(t?.reason, "Runner exit")
  };
}

export function generateSignals(trades) {
  const out = [];
  const list = Array.isArray(trades) ? trades : [];

  for (const t of list) {
    const action = normalizeAction(t?.action);

    if (action === "ENTRY") {
      out.push(entrySignal(t));
      continue;
    }

    if (action === "ADD") {
      out.push(addSignal(t));
      continue;
    }

    if (action === "PARTIAL_TP") {
      out.push(partialSignal(t));
      continue;
    }

    if (action === "MOVE_BE") {
      out.push(moveBeSignal(t));
      continue;
    }

    if (action === "TRAIL") {
      out.push(trailSignal(t));
      continue;
    }

    if (action === "EXIT" || action === "TP" || action === "SL") {
      out.push(exitSignal(t));
    }
  }

  return out;
}