// lib/marketClassifier.js

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getChange24(c) {
  return safeNumber(
    c?.change24 ??
      c?.price_change_percentage_24h ??
      c?.price_change_percentage_24h_in_currency,
    0
  );
}

function getChange1h(c) {
  return safeNumber(
    c?.change1h ??
      c?.price_change_percentage_1h_in_currency,
    0
  );
}

function getVm(c) {
  const direct = safeNumber(c?.vm, NaN);

  if (Number.isFinite(direct)) return direct;

  const volume = safeNumber(c?.total_volume ?? c?.volume, 0);
  const marketCap = safeNumber(c?.market_cap ?? c?.marketCap, 0);

  return marketCap > 0 ? volume / marketCap : 0;
}

function pct(part, total) {
  return total > 0 ? (part / total) * 100 : 0;
}

export function classifyMarket(coins = []) {
  const list = Array.isArray(coins) ? coins : [];
  const total = list.length || 1;

  let trending = 0;
  let choppy = 0;
  let runner = 0;
  let highVol = 0;

  let bullish = 0;
  let bearish = 0;

  let volumeExpansion = 0;

  for (const coin of list) {
    const ch24 = getChange24(coin);
    const ch1 = getChange1h(coin);
    const vm = getVm(coin);

    const abs24 = Math.abs(ch24);
    const abs1 = Math.abs(ch1);

    if (abs24 > 6 && abs1 > 1) trending++;
    if (abs1 < 0.25) choppy++;

    if (abs1 > 0.65 && vm > 0.035) runner++;
    if (abs24 > 10 || abs1 > 1.5) highVol++;

    if (vm > 0.08) volumeExpansion++;

    if (ch24 > 0.6 && ch1 > 0.15) bullish++;
    if (ch24 < -0.6 && ch1 < -0.15) bearish++;
  }

  const trendPerc = pct(trending, total);
  const chopPerc = pct(choppy, total);
  const runnerPerc = pct(runner, total);
  const highVolPerc = pct(highVol, total);
  const volumeExpansionPerc = pct(volumeExpansion, total);

  const bullishPerc = pct(bullish, total);
  const bearishPerc = pct(bearish, total);

  let state = "BALANCED";

  if (runnerPerc > 24 || trendPerc > 25) state = "TRENDING";
  if (highVolPerc > 28) state = "HIGH_VOL";
  if (chopPerc > 44 && runnerPerc < 14) state = "CHOPPY";

  let trend = "NEUTRAL";

  if (bullishPerc > bearishPerc + 8) trend = "BULLISH";
  if (bearishPerc > bullishPerc + 8) trend = "BEARISH";

  let runnerMode = "NORMAL";

  if (runnerPerc > 28 && volumeExpansionPerc > 20) runnerMode = "HOT";
  else if (runnerPerc > 16) runnerMode = "ACTIVE";
  else if (chopPerc > 50) runnerMode = "COLD";

  return {
    state,
    trend,
    runnerMode,

    total: list.length,

    trending,
    choppy,
    runner,
    highVol,
    bullish,
    bearish,
    volumeExpansion,

    trendPerc: Number(trendPerc.toFixed(2)),
    chopPerc: Number(chopPerc.toFixed(2)),
    runnerPerc: Number(runnerPerc.toFixed(2)),
    highVolPerc: Number(highVolPerc.toFixed(2)),
    bullishPerc: Number(bullishPerc.toFixed(2)),
    bearishPerc: Number(bearishPerc.toFixed(2)),
    volumeExpansionPerc: Number(volumeExpansionPerc.toFixed(2)),

    generatedAt: Date.now()
  };
}