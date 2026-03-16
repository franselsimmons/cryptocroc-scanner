function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function up(x) {
  return String(x || "").toUpperCase();
}

export function getMarketCapBand(marketCap) {
  const mc = n(marketCap, 0);
  if (mc <= 25_000_000) return "micro";
  if (mc <= 120_000_000) return "small";
  if (mc <= 500_000_000) return "mid";
  if (mc <= 2_000_000_000) return "upper";
  return "large";
}

export function getLiquidityBand({ depthMinUsd1p, volume, spreadPct }) {
  const depth = n(depthMinUsd1p, 0);
  const vol = n(volume, 0);
  const spread = n(spreadPct, 999);

  if (depth >= 50_000 && vol >= 5_000_000 && spread <= 0.35) return "thick";
  if (depth >= 12_000 && vol >= 1_500_000 && spread <= 0.80) return "medium";
  return "thin";
}

export function getVolatilityBand({ range24, change24 }) {
  const r = Math.abs(n(range24, 0));
  const c = Math.abs(n(change24, 0));
  const x = Math.max(r, c);

  if (x >= 25) return "extreme";
  if (x >= 12) return "high";
  if (x >= 5) return "normal";
  return "low";
}

export function buildCoinProfile({ systemType, coin }) {
  const marketCapBand = getMarketCapBand(coin?.marketCap);
  const liquidityBand = getLiquidityBand({
    depthMinUsd1p: coin?.ob?.depthMinUsd1p,
    volume: coin?.volume,
    spreadPct: coin?.ob?.spreadPct,
  });
  const volatilityBand = getVolatilityBand({
    range24: coin?.range24,
    change24: coin?.change24,
  });

  let tradabilityBand = "normal";

  if (systemType === "main") {
    if (
      (marketCapBand === "micro" && liquidityBand === "thin") ||
      volatilityBand === "extreme"
    ) {
      tradabilityBand = "fragile";
    } else if (
      (liquidityBand === "medium" || liquidityBand === "thick") &&
      (marketCapBand === "mid" || marketCapBand === "upper" || marketCapBand === "large")
    ) {
      tradabilityBand = "strong";
    }
  } else {
    if (volatilityBand === "extreme" && liquidityBand === "thin") {
      tradabilityBand = "fragile";
    } else if (
      (marketCapBand === "micro" || marketCapBand === "small") &&
      (volatilityBand === "high" || volatilityBand === "extreme")
    ) {
      tradabilityBand = "explosive";
    } else if (liquidityBand === "medium" || liquidityBand === "thick") {
      tradabilityBand = "strong";
    }
  }

  return {
    systemType,
    marketCapBand,
    liquidityBand,
    volatilityBand,
    tradabilityBand,
  };
}

function getMainDepthMin(profile) {
  if (profile.marketCapBand === "micro") return 8000;
  if (profile.marketCapBand === "small") return 12000;
  if (profile.marketCapBand === "mid") return 18000;
  if (profile.marketCapBand === "upper") return 30000;
  return 50000;
}

function getMoonDepthMin(profile) {
  if (profile.marketCapBand === "micro") return 2500;
  if (profile.marketCapBand === "small") return 5000;
  if (profile.marketCapBand === "mid") return 9000;
  if (profile.marketCapBand === "upper") return 15000;
  return 25000;
}

function getMainSpreadMax(profile) {
  if (profile.volatilityBand === "extreme") return 0.55;
  if (profile.volatilityBand === "high") return 0.70;
  if (profile.marketCapBand === "micro") return 0.85;
  return 0.60;
}

function getMoonSpreadMax(profile) {
  if (profile.marketCapBand === "micro") return 1.35;
  if (profile.marketCapBand === "small") return 1.05;
  if (profile.marketCapBand === "mid") return 0.85;
  return 0.70;
}

function isBtcAligned({ mode, btc, strict = false }) {
  const state = up(btc?.state || "NEUTRAL");
  const chg24 = n(btc?.chg24, 0);
  const range24 = n(btc?.range24, 0);

  if (mode === "bull") {
    if (strict) return state === "BULL" || (chg24 >= 0.8 && range24 >= 2.5);
    return state !== "BEAR";
  }

  if (strict) return state === "BEAR" || (chg24 <= -0.8 && range24 >= 2.5);
  return state !== "BULL";
}

function isLateEntryMain({ mode, coin }) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const velocity = n(coin?.velocity, 0);

  if (mode === "bull") {
    if (ch1h >= 8 && ch24 >= 18) return true;
    if (ch1h >= 5.5 && ch24 >= 24) return true;
    if (velocity >= 0.42 && ch24 >= 20) return true;
    return false;
  }

  if (ch1h <= -8 && ch24 <= -18) return true;
  if (ch1h <= -5.5 && ch24 <= -24) return true;
  if (velocity >= 0.42 && ch24 <= -20) return true;
  return false;
}

function isLateEntryMoon({ mode, coin }) {
  const ch1h = n(coin?.change1h, 0);
  const ch24 = n(coin?.change24, 0);
  const velocity = n(coin?.velocity, 0);

  if (mode === "bull") {
    if (ch1h >= 12 && ch24 >= 28) return true;
    if (ch1h >= 9 && ch24 >= 38) return true;
    if (velocity >= 0.55 && ch24 >= 24) return true;
    return false;
  }

  if (ch1h <= -12 && ch24 <= -28) return true;
  if (ch1h <= -9 && ch24 <= -38) return true;
  if (velocity >= 0.55 && ch24 <= -24) return true;
  return false;
}

function computeSide(mode) {
  return mode === "bear" ? "SHORT" : "LONG";
}

function summarizeReason(blocks) {
  return blocks.filter(Boolean).slice(0, 3).join(" • ");
}

function positionSizeForDecision({ systemType, profile, score }) {
  let base = systemType === "moon" ? 35 : 50;

  if (profile.tradabilityBand === "fragile") base *= 0.60;
  if (profile.tradabilityBand === "strong") base *= 1.10;
  if (profile.tradabilityBand === "explosive") base *= 0.80;

  if (score >= 90) base *= 1.20;
  else if (score >= 82) base *= 1.00;
  else if (score >= 75) base *= 0.75;
  else base *= 0.50;

  return Math.round(base);
}

function buildChecklistItem(name, ok, value, need) {
  return { name, ok: !!ok, value, need };
}

export function buildMainExecutionDecision({ coin, btc, regime, mode, coinProfile }) {
  const profile = coinProfile;
  const spread = n(coin?.ob?.spreadPct, 999);
  const depth = n(coin?.ob?.depthMinUsd1p, 0);
  const obScore = n(coin?.ob?.score, 0);
  const entryQuality = n(coin?.entryQuality || coin?.confidence, 0);
  const persistenceScore = n(coin?.persistenceScore, 0);
  const velocity = n(coin?.velocity, 0);
  const volShort = n(coin?.volAcc?.short, 1);
  const breakoutReady = !!coin?.breakout?.ready;
  const stage = up(coin?.stage);
  const tradePlanOk = !!coin?.tradePlan;
  const btcOk = isBtcAligned({ mode, btc, strict: true });

  const spreadMax = getMainSpreadMax(profile);
  const depthMin = getMainDepthMin(profile);
  const spreadOk = spread <= spreadMax;
  const depthOk = depth >= depthMin && !!coin?.thresholds?.depthOk;
  const obOk = Math.abs(obScore) >= 0.04;
  const late = isLateEntryMain({ mode, coin });
  const qualityOk = entryQuality >= 72;
  const persistenceOk = persistenceScore >= 65;
  const velocityOk = velocity >= 0.10;
  const volOk = volShort >= 1.02;
  const stageOk = stage === "ELITE_IGNITION" || stage === "ELITE_EXPANSION" || stage === "ELITE_CASCADE";

  const checklist = [
    buildChecklistItem("Stage", stageOk, stage, "ELITE"),
    buildChecklistItem("BTC aligned", btcOk, up(btc?.state || "NEUTRAL"), "aligned"),
    buildChecklistItem("Breakout ready", breakoutReady, breakoutReady ? "ja" : "nee", "ja"),
    buildChecklistItem("Spread", spreadOk, spread.toFixed(3) + "%", "<= " + spreadMax.toFixed(2) + "%"),
    buildChecklistItem("Depth", depthOk, "$" + Math.round(depth).toLocaleString(), ">= $" + Math.round(depthMin).toLocaleString()),
    buildChecklistItem("OB score", obOk, obScore.toFixed(4), ">= 0.040 abs"),
    buildChecklistItem("Entry quality", qualityOk, String(entryQuality), ">= 72"),
    buildChecklistItem("Persistence", persistenceOk, String(persistenceScore), ">= 65"),
    buildChecklistItem("Velocity", velocityOk, velocity.toFixed(3), ">= 0.10"),
    buildChecklistItem("Vol accel", volOk, volShort.toFixed(3), ">= 1.02"),
    buildChecklistItem("Late entry", !late, late ? "te laat" : "ok", "niet laat"),
    buildChecklistItem("Trade plan", tradePlanOk, tradePlanOk ? "ja" : "nee", "ja"),
  ];

  let score = 0;
  if (stageOk) score += 14;
  if (btcOk) score += 12;
  if (breakoutReady) score += 12;
  if (spreadOk) score += 8;
  if (depthOk) score += 10;
  if (obOk) score += 8;
  if (qualityOk) score += 10;
  if (persistenceOk) score += 8;
  if (velocityOk) score += 4;
  if (volOk) score += 4;
  if (!late) score += 6;
  if (tradePlanOk) score += 4;

  if (String(regime || "").toUpperCase() === "HEADWIND") score -= 12;
  if (profile.tradabilityBand === "fragile") score -= 8;
  if (profile.tradabilityBand === "strong") score += 3;

  score = clamp(score, 0, 100);

  const ready =
    stageOk &&
    btcOk &&
    breakoutReady &&
    spreadOk &&
    depthOk &&
    obOk &&
    qualityOk &&
    persistenceOk &&
    volOk &&
    !late &&
    tradePlanOk;

  let action = "SKIP";
  if (ready) action = "OPEN";
  else if (stageOk && qualityOk && !late) action = "WATCH";
  else if (stage === "HOLD") action = "HOLD";

  const reasons = [];
  if (!btcOk) reasons.push("BTC niet aligned");
  if (!spreadOk) reasons.push("spread te hoog");
  if (!depthOk) reasons.push("depth te laag");
  if (!obOk) reasons.push("OB score te zwak");
  if (!breakoutReady) reasons.push("breakout niet ready");
  if (!qualityOk) reasons.push("entry quality te laag");
  if (!persistenceOk) reasons.push("persistence te laag");
  if (late) reasons.push("late entry");
  if (!tradePlanOk) reasons.push("geen trade plan");

  return {
    systemType: "main",
    side: computeSide(mode),
    ready,
    action,
    score,
    reason: ready ? "klaar voor trade" : summarizeReason(reasons),
    positionSizeUsd: positionSizeForDecision({ systemType: "main", profile, score }),
    checklist,
    thresholds: {
      spreadMax,
      depthMin,
      obScoreMinAbs: 0.04,
      entryQualityMin: 72,
      persistenceMin: 65,
    },
  };
}

export function buildMoonExecutionDecision({ coin, btc, regime, mode, coinProfile }) {
  const profile = coinProfile;
  const spread = n(coin?.ob?.spreadPct, 999);
  const depth = n(coin?.ob?.depthMinUsd1p, 0);
  const obScore = n(coin?.ob?.score, 0);
  const entryQuality = n(coin?.entryQuality || coin?.confidence, 0);
  const persistenceScore = n(coin?.persistenceScore, 0);
  const velocity = n(coin?.velocity, 0);
  const volShort = n(coin?.volAcc?.short, 1);
  const volMedium = n(coin?.volAcc?.medium, 1);
  const breakoutReady = !!coin?.breakout?.ready;
  const stage = up(coin?.stage);
  const tradePlanOk = !!coin?.tradePlan;
  const btcOk = isBtcAligned({ mode, btc, strict: false });

  const spreadMax = getMoonSpreadMax(profile);
  const depthMin = getMoonDepthMin(profile);
  const spreadOk = spread <= spreadMax;
  const depthOk = depth >= depthMin && !!coin?.thresholds?.depthOk;
  const obOk = Math.abs(obScore) >= 0.025;
  const late = isLateEntryMoon({ mode, coin });
  const qualityOk = entryQuality >= 68;
  const persistenceOk = persistenceScore >= 58;
  const velocityOk = velocity >= 0.13;
  const volOk = volShort >= 1.01 || volMedium >= 1.05;
  const stageOk = stage === "ELITE_IGNITION" || stage === "ELITE_EXPANSION" || stage === "ELITE_CASCADE";

  const checklist = [
    buildChecklistItem("Stage", stageOk, stage, "ELITE"),
    buildChecklistItem("BTC not opposing", btcOk, up(btc?.state || "NEUTRAL"), "niet tegen"),
    buildChecklistItem("Breakout ready", breakoutReady, breakoutReady ? "ja" : "nee", "ja"),
    buildChecklistItem("Spread", spreadOk, spread.toFixed(3) + "%", "<= " + spreadMax.toFixed(2) + "%"),
    buildChecklistItem("Depth", depthOk, "$" + Math.round(depth).toLocaleString(), ">= $" + Math.round(depthMin).toLocaleString()),
    buildChecklistItem("OB score", obOk, obScore.toFixed(4), ">= 0.025 abs"),
    buildChecklistItem("Entry quality", qualityOk, String(entryQuality), ">= 68"),
    buildChecklistItem("Persistence", persistenceOk, String(persistenceScore), ">= 58"),
    buildChecklistItem("Velocity", velocityOk, velocity.toFixed(3), ">= 0.13"),
    buildChecklistItem("Vol accel", volOk, `${volShort.toFixed(3)} / ${volMedium.toFixed(3)}`, ">= 1.01 / 1.05"),
    buildChecklistItem("Late entry", !late, late ? "te laat" : "ok", "niet laat"),
    buildChecklistItem("Trade plan", tradePlanOk, tradePlanOk ? "ja" : "nee", "ja"),
  ];

  let score = 0;
  if (stageOk) score += 14;
  if (btcOk) score += 8;
  if (breakoutReady) score += 12;
  if (spreadOk) score += 6;
  if (depthOk) score += 8;
  if (obOk) score += 8;
  if (qualityOk) score += 10;
  if (persistenceOk) score += 8;
  if (velocityOk) score += 8;
  if (volOk) score += 6;
  if (!late) score += 8;
  if (tradePlanOk) score += 4;

  if (String(regime || "").toUpperCase() === "EXPANSION") score += 4;
  if (String(regime || "").toUpperCase() === "HEADWIND") score -= 8;
  if (profile.tradabilityBand === "fragile") score -= 10;
  if (profile.tradabilityBand === "explosive") score += 4;

  score = clamp(score, 0, 100);

  const ready =
    stageOk &&
    btcOk &&
    breakoutReady &&
    spreadOk &&
    depthOk &&
    obOk &&
    qualityOk &&
    persistenceOk &&
    velocityOk &&
    volOk &&
    !late &&
    tradePlanOk;

  let action = "SKIP";
  if (ready) action = "OPEN";
  else if (stageOk && qualityOk && !late) action = "WATCH";
  else if (stage === "HOLD") action = "HOLD";

  const reasons = [];
  if (!btcOk) reasons.push("BTC tegen de setup");
  if (!spreadOk) reasons.push("spread te hoog");
  if (!depthOk) reasons.push("depth te laag");
  if (!obOk) reasons.push("OB score te zwak");
  if (!breakoutReady) reasons.push("breakout niet ready");
  if (!qualityOk) reasons.push("entry quality te laag");
  if (!persistenceOk) reasons.push("persistence te laag");
  if (!velocityOk) reasons.push("velocity te zwak");
  if (!volOk) reasons.push("volume accel te zwak");
  if (late) reasons.push("late moon chase");
  if (!tradePlanOk) reasons.push("geen trade plan");

  return {
    systemType: "moon",
    side: computeSide(mode),
    ready,
    action,
    score,
    reason: ready ? "klaar voor trade" : summarizeReason(reasons),
    positionSizeUsd: positionSizeForDecision({ systemType: "moon", profile, score }),
    checklist,
    thresholds: {
      spreadMax,
      depthMin,
      obScoreMinAbs: 0.025,
      entryQualityMin: 68,
      persistenceMin: 58,
    },
  };
}