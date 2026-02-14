export const config = { runtime: "nodejs" };

// =======================
// FINAL DEFAULTS V1
// =======================
export const CFG = {
  // Universe
  poolMax: 250,
  bitgetSymbolsCacheSec: 24 * 60 * 60,

  // Pool (RADAR instroom) - "breed radar"
  pool: {
    mcapMin: 5_000_000,
    // mcapMax: null, // bewust uit (te strak = minder instroom)
    volMin: 500_000,
    vmMin: 0.15,
    absChange24Max: 35,  // %
    range24Max: 30       // %
  },

  // BTC gate (simpel + robuust op CoinGecko data)
  btcGate: {
    bull: { change24Min: +0.8, range24Min: 2.0, range24Max: 8.0 },
    bear: { change24Max: -0.8, range24Min: 2.0, range24Max: 10.0 }
  },

  // Stages (we tonen 4 tabellen, maar intern labelen we RADAR/BUILDUP/ALMOST in de RADAR tabel)
  stage: {
    // timeouts in minuten
    radarTimeoutMin: 60,
    buildupTimeoutMin: 90,
    almostTimeoutMin: 60,
    entryTimeoutMin: 45,
    cooldownMin: 60,

    // min scans in stage voordat doorschuiven mag
    minScansPerStage: 2
  },

  // BUILDUP
  buildup: {
    change24MinAbs: 1.2, // bull: >= +1.2, bear: <= -1.2
    vmMin: 0.22,
    volMin: 1_200_000,
    consistencyMin: 0.67, // 4/6
    consistencyWindow: 6
  },

  // ALMOST
  almost: {
    vmMin: 0.26,
    volMin: 2_000_000,
    // consolidatie maat (laatste 6 scans range <= X%)
    priceFlatMax: 6.5,
    priceFlatWindow: 6,

    // volume acceleration: (laatste3 / vorige3) - 1 >= 0.12  => ratio >= 1.12
    volAccRatioMin: 1.12
  },

  // ENTRY
  entry: {
    change24AbsMin: 2,
    change24AbsMax: 22,

    // late move exception (22..35) alleen als super sterk
    lateMoveAbsMax: 35,
    lateMoveVmMin: 0.35,
    lateMoveObMin: 0.12,

    // Fast-track: BUILDUP -> ENTRY overslaan ALMOST alleen bij super OB + volume
    fastTrack: {
      obMin: 0.12,
      volMin: 3_000_000
    }
  },

  // Orderbook gate + sampling
  ob: {
    depthLimit: 50,
    depthPct: 0.002,          // 0.2%
    spreadMaxEntry: 0.55,     // %
    obScoreMin: 0.06,         // bull >= +0.06, bear <= -0.06

    samplesNeed: 3,
    samplesWindowSec: 90,
    staleSec: 15,
    maxCallsPerScan: 15,

    largestOrderRatioMax: 0.35
  },

  // HOLD/SELL
  hold: {
    // trailing OB: abs(current) >= abs(peak)*0.6
    trailKeep: 0.6,
    // SELL als OB terugvalt naar "bijna neutraal"
    sellNeutralAbs: 0.02,
    // SELL als overextended
    overextendedAbsChange: 35
  },

  // Output expiry (als BTC neutral: we legen output)
  outputExpiryMin: 15
};

// =======================
// Helpers
// =======================
export const now = () => Date.now();

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export async function fetchJSON(url, { timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { "accept": "application/json" } });
    if (!r.ok) throw new Error(`Fetch failed ${r.status} ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export function vmRatio(volume, marketCap) {
  if (!marketCap || marketCap <= 0) return 0;
  return volume / marketCap;
}

export function pct(n) {
  return Number.isFinite(n) ? n : 0;
}

export function calcRangePct(low24, high24, price) {
  const p = Number(price);
  const lo = Number(low24);
  const hi = Number(high24);
  if (!p || !lo || !hi) return 0;
  return ((hi - lo) / p) * 100;
}

export function minutesToMs(m) {
  return m * 60_000;
}
