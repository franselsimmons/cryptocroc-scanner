// lib/institutional.js

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function avg(arr) {
  const list = safeArray(arr).map(Number).filter(Number.isFinite);
  if (!list.length) return 0;

  return list.reduce((a, b) => a + b, 0) / list.length;
}

function stable(arr, maxVarianceRatio = 0.30) {
  const list = safeArray(arr).map(Number).filter(Number.isFinite);
  const a = avg(list);

  if (!a) return false;

  const variance = list.reduce((sum, value) => sum + Math.abs(value - a), 0) / list.length;
  return variance / a < maxVarianceRatio;
}

function topVolume(snapshot, side, levels = 5) {
  return safeArray(snapshot?.[side])
    .slice(0, levels)
    .reduce((sum, level) => sum + safeNumber(level?.[1], 0), 0);
}

function topPrice(snapshot, side) {
  return safeNumber(snapshot?.[side]?.[0]?.[0], 0);
}

function getMid(snapshot) {
  if (safeNumber(snapshot?.mid, 0) > 0) return safeNumber(snapshot.mid);

  const bid = topPrice(snapshot, "bids");
  const ask = topPrice(snapshot, "asks");

  if (!bid || !ask) return 0;

  return (bid + ask) / 2;
}

function getPriceStability(history, lookback = 5) {
  const prices = safeArray(history)
    .slice(-lookback)
    .map(getMid)
    .filter(p => p > 0);

  if (prices.length < 3) return false;

  const first = prices[0];
  const last = prices[prices.length - 1];

  if (!first || !last) return false;

  const changePct = Math.abs((last - first) / first) * 100;

  return changePct < 0.25;
}

// ================= WALL PERSISTENCE =================
export function detectWallPersistence(history) {
  const list = safeArray(history);

  if (list.length < 5) {
    return {
      bidWallStrong: false,
      askWallStrong: false,
      bidWallAvg: 0,
      askWallAvg: 0
    };
  }

  const last = list.slice(-5);

  const bidWall = last.map(h => safeNumber(h?.bids?.[0]?.[1], 0));
  const askWall = last.map(h => safeNumber(h?.asks?.[0]?.[1], 0));

  return {
    bidWallStrong: stable(bidWall),
    askWallStrong: stable(askWall),
    bidWallAvg: avg(bidWall),
    askWallAvg: avg(askWall)
  };
}

// ================= ABSORPTION =================
export function detectAbsorption(c, history) {
  const list = safeArray(history);

  if (list.length < 5) {
    return {
      absorbingBids: false,
      absorbingAsks: false,
      bidAvg: 0,
      askAvg: 0,
      priceStable: false
    };
  }

  const side = String(c?.side || "").toLowerCase();
  const priceMove = safeNumber(c?.change1h, 0);
  const last = list.slice(-5);

  const bidPressure = last.map(h => topVolume(h, "bids", 5));
  const askPressure = last.map(h => topVolume(h, "asks", 5));

  const bidAvg = avg(bidPressure);
  const askAvg = avg(askPressure);
  const priceStable = getPriceStability(last, 5);

  const absorbingBids =
    priceMove < 0 &&
    bidAvg > askAvg * 1.2 &&
    priceStable;

  const absorbingAsks =
    priceMove > 0 &&
    askAvg > bidAvg * 1.2 &&
    priceStable;

  const runnerAbsorption =
    side === "bull"
      ? bidAvg > askAvg * 1.15
      : askAvg > bidAvg * 1.15;

  return {
    absorbingBids,
    absorbingAsks,
    runnerAbsorption,
    bidAvg,
    askAvg,
    priceStable
  };
}

// ================= SPOOFING =================
export function detectSpoofing(history) {
  const list = safeArray(history);

  if (list.length < 5) {
    return {
      spoof: false,
      bidSpoof: false,
      askSpoof: false,
      spikes: 0
    };
  }

  const last = list.slice(-6);

  const detectSideSpoof = (side) => {
    const vols = last.map(h => safeNumber(h?.[side]?.[0]?.[1], 0));
    let spikes = 0;
    let fades = 0;

    for (let i = 1; i < vols.length; i++) {
      if (vols[i] > vols[i - 1] * 1.8) spikes++;
      if (vols[i - 1] > 0 && vols[i] < vols[i - 1] * 0.45) fades++;
    }

    return {
      spoof: spikes >= 2 || (spikes >= 1 && fades >= 2),
      spikes,
      fades
    };
  };

  const bid = detectSideSpoof("bids");
  const ask = detectSideSpoof("asks");

  return {
    spoof: bid.spoof || ask.spoof,
    bidSpoof: bid.spoof,
    askSpoof: ask.spoof,
    spikes: bid.spikes + ask.spikes,
    bidFades: bid.fades,
    askFades: ask.fades
  };
}

// ================= RUNNER ORDERBOOK PRESSURE =================
export function detectOrderbookPressure(c, history) {
  const list = safeArray(history);

  if (list.length < 3) {
    return {
      bias: "NEUTRAL",
      score: 0,
      imbalance: 1,
      valid: false
    };
  }

  const last = list.slice(-5);

  const bidAvg = avg(last.map(h => topVolume(h, "bids", 5)));
  const askAvg = avg(last.map(h => topVolume(h, "asks", 5)));

  const imbalance = askAvg > 0 ? bidAvg / askAvg : 1;

  const side = String(c?.side || "").toLowerCase();
  const spoof = detectSpoofing(last);
  const absorption = detectAbsorption(c, last);
  const walls = detectWallPersistence(last);

  let bias = "NEUTRAL";
  let score = 0;

  if (imbalance >= 1.25) {
    bias = "BULLISH";
    score += 35;
  }

  if (imbalance <= 0.80) {
    bias = "BEARISH";
    score += 35;
  }

  if (side === "bull" && bias === "BULLISH") score += 25;
  if (side === "bear" && bias === "BEARISH") score += 25;

  if (absorption.runnerAbsorption) score += 12;
  if (side === "bull" && walls.bidWallStrong) score += 8;
  if (side === "bear" && walls.askWallStrong) score += 8;

  if (spoof.spoof) score -= 25;
  if (side === "bull" && spoof.bidSpoof) score -= 12;
  if (side === "bear" && spoof.askSpoof) score -= 12;

  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    bias,
    score,
    imbalance,
    valid: score >= 45,
    spoof: spoof.spoof,
    bidAvg,
    askAvg,
    absorption,
    walls
  };
}