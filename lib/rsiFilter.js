// lib/rsiFilter.js
// RUNNER RSI FILTER
// Backward-compatible helpers voor zone-detectie en alignment.

const RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT",
  "BUILDING"
]);

const HOT_RUNNER_FLOWS = new Set([
  "SQUEEZE",
  "RUNNING",
  "BREAKOUT"
]);

export function getRsiZoneDynamic(rsi, zones) {
  const value = Number(rsi);

  if (!Number.isFinite(value) || !zones) return "MID";

  if (value >= zones.U3) return "UPPER_3";
  if (value >= zones.U2) return "UPPER_2";
  if (value >= zones.U1) return "UPPER_1";

  if (value <= zones.L3) return "LOWER_3";
  if (value <= zones.L2) return "LOWER_2";
  if (value <= zones.L1) return "LOWER_1";

  return "MID";
}

export function isLowerRsiZone(zone) {
  return String(zone || "").startsWith("LOWER");
}

export function isUpperRsiZone(zone) {
  return String(zone || "").startsWith("UPPER");
}

export function isMidRsiZone(zone) {
  return String(zone || "") === "MID";
}

function normalizeFlow(flow) {
  return String(flow || "NEUTRAL").toUpperCase();
}

// Runner alignment:
// LONG:
// - pullback lower zone is ok
// - MID is ok
// - UPPER_1/UPPER_2 can be ok for continuation
// SHORT:
// - pullback upper zone is ok
// - MID is ok
// - LOWER_1/LOWER_2 can be ok for continuation
export function isRsiAligned(isBull, zone, rsiSignal = null) {
  if (!zone) return false;

  const continuationScore = Number(rsiSignal?.continuationScore || 0);

  if (isBull) {
    if (isLowerRsiZone(zone) || isMidRsiZone(zone)) return true;
    if (zone === "UPPER_1" && continuationScore >= 5) return true;
    if (zone === "UPPER_2" && continuationScore >= 7 && Number(rsiSignal?.slope3 || 0) >= -0.25) return true;
    return false;
  }

  if (isUpperRsiZone(zone) || isMidRsiZone(zone)) return true;
  if (zone === "LOWER_1" && continuationScore >= 5) return true;
  if (zone === "LOWER_2" && continuationScore >= 7 && Number(rsiSignal?.slope3 || 0) <= 0.25) return true;

  return false;
}

// Hard exhaustion block:
// Runner blokkeert alleen bij extreme RSI + momentumverlies.
export function isRsiExhaustedAgainstSide(isBull, zone, rsiSignal = null) {
  if (!zone) return false;

  const rsi = Number(rsiSignal?.rsi || 50);
  const slope3 = Number(rsiSignal?.slope3 || 0);
  const fastSlope3 = Number(rsiSignal?.fastSlope3 || 0);

  if (isBull) {
    return (
      (zone === "UPPER_3" && rsi > 88 && slope3 < 0) ||
      (zone === "UPPER_3" && fastSlope3 < -1.25)
    );
  }

  return (
    (zone === "LOWER_3" && rsi < 12 && slope3 > 0) ||
    (zone === "LOWER_3" && fastSlope3 > 1.25)
  );
}

// Runner continuation check.
export function isRsiContinuationAllowed({
  isBull,
  zone,
  rsiSignal,
  confluence = 0,
  sniperScore = 0,
  runnerScore = 0,
  rr = 0,
  flow = "NEUTRAL"
}) {
  if (!zone || !rsiSignal?.valid) return false;

  const normalizedFlow = normalizeFlow(flow);
  if (!RUNNER_FLOWS.has(normalizedFlow)) return false;
  if (rr < 1.10) return false;

  const continuationScore = Number(rsiSignal?.continuationScore || 0);
  const slope3 = Number(rsiSignal?.slope3 || 0);
  const score = Math.max(Number(sniperScore || 0), Number(runnerScore || 0));

  if (isBull) {
    if (zone === "MID") {
      return (
        continuationScore >= 5 &&
        confluence >= 66 &&
        score >= 55
      );
    }

    if (zone === "UPPER_1") {
      return (
        HOT_RUNNER_FLOWS.has(normalizedFlow) &&
        continuationScore >= 6 &&
        confluence >= 70 &&
        slope3 >= -0.25
      );
    }

    if (zone === "UPPER_2") {
      return (
        normalizedFlow === "SQUEEZE" &&
        continuationScore >= 8 &&
        confluence >= 76 &&
        slope3 >= 0
      );
    }

    if (zone === "LOWER_1") {
      return (
        confluence >= 64 &&
        score >= 50 &&
        slope3 >= -0.75
      );
    }

    return false;
  }

  if (zone === "MID") {
    return (
      continuationScore >= 5 &&
      confluence >= 66 &&
      score >= 55
    );
  }

  if (zone === "LOWER_1") {
    return (
      HOT_RUNNER_FLOWS.has(normalizedFlow) &&
      continuationScore >= 6 &&
      confluence >= 70 &&
      slope3 <= 0.25
    );
  }

  if (zone === "LOWER_2") {
    return (
      normalizedFlow === "SQUEEZE" &&
      continuationScore >= 8 &&
      confluence >= 76 &&
      slope3 <= 0
    );
  }

  if (zone === "UPPER_1") {
    return (
      confluence >= 64 &&
      score >= 50 &&
      slope3 <= 0.75
    );
  }

  return false;
}

// Pullback entry check.
export function isRsiPullbackEntry({
  isBull,
  zone,
  rsiSignal,
  sniperScore = 0,
  runnerScore = 0
}) {
  if (!zone || !rsiSignal?.valid) return false;

  const score = Math.max(Number(sniperScore || 0), Number(runnerScore || 0));

  if (isBull) {
    if (zone === "LOWER_3") return true;
    if (zone === "LOWER_2") return true;
    if (zone === "LOWER_1") return score >= 62 || rsiSignal?.rising;
    if (zone === "MID") return Number(rsiSignal?.continuationScore || 0) >= 7;
    return false;
  }

  if (zone === "UPPER_3") return true;
  if (zone === "UPPER_2") return true;
  if (zone === "UPPER_1") return score >= 62 || rsiSignal?.falling;
  if (zone === "MID") return Number(rsiSignal?.continuationScore || 0) >= 7;

  return false;
}

export function getRsiRunnerBias(rsiSignal, side) {
  if (!rsiSignal?.valid) {
    return {
      bias: "UNKNOWN",
      score: 0,
      blocked: false
    };
  }

  const isBull = String(side || "").toLowerCase() !== "bear";
  const zone = rsiSignal.zone || getRsiZoneDynamic(rsiSignal.rsi, rsiSignal.zones);
  const continuationScore = Number(rsiSignal.continuationScore || 0);
  const pullbackOK = Boolean(rsiSignal.pullbackOK);
  const exhausted = isRsiExhaustedAgainstSide(isBull, zone, rsiSignal);

  if (exhausted || rsiSignal.blocked) {
    return {
      bias: "BLOCK",
      score: -10,
      blocked: true
    };
  }

  let score = 0;

  if (isRsiAligned(isBull, zone, rsiSignal)) score += 4;
  if (pullbackOK) score += 2;
  if (continuationScore >= 5) score += 3;
  if (continuationScore >= 8) score += 2;

  return {
    bias:
      score >= 8 ? "STRONG_RUNNER_RSI" :
      score >= 5 ? "RUNNER_RSI_OK" :
      "WEAK_RSI",
    score,
    blocked: false,
    zone,
    continuationScore
  };
}