// lib/_trade_engine.js

// ======================================================
// Hulpfuncties
// ======================================================
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

// ======================================================
// BTC alignment check
// ======================================================
function isBtcAligned({ mode, btc, strict = false }) {
  const btcState = up(btc?.state || "NEUTRAL");
  const btcChg24 = n(btc?.chg24, 0);
  const btcRange24 = n(btc?.range24, 0);

  // strict = true → alleen BULL voor longs, BEAR voor shorts
  if (strict) {
    if (mode === "bull" && btcState !== "BULL") return false;
    if (mode === "bear" && btcState !== "BEAR") return false;
    return true;
  }

  // strict = false → alleen blokkeren als BTC tegen je in beweegt
  if (mode === "bull" && btcState === "BEAR" && btcChg24 < -1.5 && btcRange24 > 3.0) return false;
  if (mode === "bear" && btcState === "BULL" && btcChg24 > 1.5 && btcRange24 > 3.0) return false;
  return true;
}

// ======================================================
// Coin profiel opbouwen
// ======================================================
export function buildCoinProfile({ systemType, coin }) {
  const marketCap = n(coin.marketCap, 0);
  const volume = n(coin.volume, 0);
  const spread = n(coin.ob?.spreadPct, 999);
  const depth = n(coin.ob?.depthMinUsd1p, 0);

  let tradabilityBand = "unknown";
  if (marketCap >= 1e9 && volume >= 10e6 && spread < 0.2 && depth > 500_000) tradabilityBand = "premium";
  else if (marketCap >= 300e6 && volume >= 3e6 && spread < 0.4 && depth > 200_000) tradabilityBand = "high";
  else if (marketCap >= 100e6 && volume >= 1e6 && spread < 0.8 && depth > 100_000) tradabilityBand = "medium";
  else tradabilityBand = "low";

  return {
    symbol: coin.symbol,
    marketCap,
    volume,
    spread,
    depth,
    tradabilityBand,
    liquidityScore: coin.liquidityScore || 0,
    qualityScore: coin.qualityScore || 0,
  };
}

// ======================================================
// Main execution decision
// ======================================================
export function buildMainExecutionDecision({ coin, btc, regime, mode, coinProfile }) {
  const checklist = [];

  // 1. BTC alignment
  const btcOk = isBtcAligned({ mode, btc, strict: false }); // AANGEPAST: strict=false
  checklist.push({ name: "BTC alignment", ok: btcOk, value: btc?.state || "NEUTRAL", need: "niet tegen" });

  // 2. Regime check
  const regimeOk = regime !== "CRASH" && regime !== "PANIC";
  checklist.push({ name: "Regime", ok: regimeOk, value: regime, need: "geen crash/panic" });

  // 3. Entry quality
  const entryQuality = n(coin.entryQuality, 0);
  const qualityOk = entryQuality >= 68; // AANGEPAST: 72 → 68
  checklist.push({ name: "Entry quality", ok: qualityOk, value: entryQuality.toFixed(1), need: "≥68" });

  // 4. Persistence score
  const persistence = n(coin.persistenceScore, 0);
  const persistenceOk = persistence >= 60; // AANGEPAST: 65 → 60
  checklist.push({ name: "Persistence", ok: persistenceOk, value: persistence.toFixed(1), need: "≥60" });

  // 5. Breakout ready
  const breakoutReady = !!coin.breakout?.ready;
  checklist.push({ name: "Breakout ready", ok: breakoutReady, value: breakoutReady ? "ja" : "nee", need: "ja" });

  // 6. Depth ok
  const depthOk = !!coin.thresholds?.depthOk;
  checklist.push({ name: "Depth OK", ok: depthOk, value: depthOk ? "ja" : "nee", need: "ja" });

  // 7. Spread ok (Main minder streng dan Moon)
  const spread = n(coin.ob?.spreadPct, 999);
  const spreadOk = spread < 0.5; // Main mag iets hogere spread hebben
  checklist.push({ name: "Spread", ok: spreadOk, value: spread.toFixed(3) + "%", need: "<0.5%" });

  // 8. Fresh orderbook
  const freshOb = coin.ob?.fresh === true;
  checklist.push({ name: "Fresh OB", ok: freshOb, value: freshOb ? "ja" : "nee", need: "ja" });

  // 9. Trade candidate flag
  const tradeCandidate = !!coin.tradeCandidate;
  checklist.push({ name: "Trade candidate", ok: tradeCandidate, value: tradeCandidate ? "ja" : "nee", need: "ja" });

  // Totaal score
  const passed = checklist.filter(c => c.ok).length;
  const total = checklist.length;
  const score = Math.round((passed / total) * 100);

  // Bepaal actie
  let action = "IGNORE";
  let reason = "";

  if (score >= 80 && tradeCandidate && btcOk && regimeOk && qualityOk && persistenceOk && breakoutReady && depthOk && spreadOk && freshOb) {
    action = "OPEN";
    reason = "Voldoet aan alle eisen";
  } else if (score >= 65 && tradeCandidate) {
    action = "WATCH";
    reason = "Bijna klaar, nog enkele checks";
  } else {
    reason = "Onvoldoende kwaliteit";
  }

  return {
    action,
    ready: action === "OPEN",
    score,
    checklist,
    reason,
    side: mode === "bull" ? "LONG" : "SHORT",
    positionSizeUsd: 50, // vast voor Main
  };
}

// ======================================================
// Moon execution decision
// ======================================================
export function buildMoonExecutionDecision({ coin, btc, regime, mode, coinProfile }) {
  const checklist = [];

  // 1. BTC alignment (strict=false)
  const btcOk = isBtcAligned({ mode, btc, strict: false });
  checklist.push({ name: "BTC alignment", ok: btcOk, value: btc?.state || "NEUTRAL", need: "niet tegen" });

  // 2. Regime check
  const regimeOk = regime !== "CRASH" && regime !== "PANIC";
  checklist.push({ name: "Regime", ok: regimeOk, value: regime, need: "geen crash/panic" });

  // 3. Entry quality (Moon soepeler)
  const entryQuality = n(coin.entryQuality, 0);
  const qualityOk = entryQuality >= 64; // AANGEPAST: 68 → 64
  checklist.push({ name: "Entry quality", ok: qualityOk, value: entryQuality.toFixed(1), need: "≥64" });

  // 4. Persistence score
  const persistence = n(coin.persistenceScore, 0);
  const persistenceOk = persistence >= 55; // AANGEPAST: 58 → 55
  checklist.push({ name: "Persistence", ok: persistenceOk, value: persistence.toFixed(1), need: "≥55" });

  // 5. Breakout ready
  const breakoutReady = !!coin.breakout?.ready;
  checklist.push({ name: "Breakout ready", ok: breakoutReady, value: breakoutReady ? "ja" : "nee", need: "ja" });

  // 6. Depth ok
  const depthOk = !!coin.thresholds?.depthOk;
  checklist.push({ name: "Depth OK", ok: depthOk, value: depthOk ? "ja" : "nee", need: "ja" });

  // 7. Spread ok (Moon strenger)
  const spread = n(coin.ob?.spreadPct, 999);
  const spreadOk = spread < 0.3;
  checklist.push({ name: "Spread", ok: spreadOk, value: spread.toFixed(3) + "%", need: "<0.3%" });

  // 8. Fresh orderbook
  const freshOb = coin.ob?.fresh === true;
  checklist.push({ name: "Fresh OB", ok: freshOb, value: freshOb ? "ja" : "nee", need: "ja" });

  // 9. Trade candidate flag
  const tradeCandidate = !!coin.tradeCandidate;
  checklist.push({ name: "Trade candidate", ok: tradeCandidate, value: tradeCandidate ? "ja" : "nee", need: "ja" });

  // Totaal score
  const passed = checklist.filter(c => c.ok).length;
  const total = checklist.length;
  const score = Math.round((passed / total) * 100);

  // Bepaal actie
  let action = "IGNORE";
  let reason = "";

  if (score >= 78 && tradeCandidate && btcOk && regimeOk && qualityOk && persistenceOk && breakoutReady && depthOk && spreadOk && freshOb) {
    action = "OPEN";
    reason = "Voldoet aan alle eisen";
  } else if (score >= 60 && tradeCandidate) {
    action = "WATCH";
    reason = "Bijna klaar, nog enkele checks";
  } else {
    reason = "Onvoldoende kwaliteit";
  }

  return {
    action,
    ready: action === "OPEN",
    score,
    checklist,
    reason,
    side: mode === "bull" ? "LONG" : "SHORT",
    positionSizeUsd: 50, // vast voor Moon
  };
}