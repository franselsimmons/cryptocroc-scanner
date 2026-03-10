// /lib/_moon_core.js
import { kv } from "@vercel/kv";

// ---------- Runtime config ----------
export const RUNTIME_CONFIG = {
  runtime: "nodejs",
};

// ========== MOON V3 CONFIGURATIE ==========
export const MOON_V3 = {
  // Market cap ranges met bonus (asymmetrie)
  MCAP_BONUS: [
    { max: 25_000_000, bonus: 15 }, // 2M-25M hoogste bonus
    { max: 80_000_000, bonus: 10 },
    { max: 180_000_000, bonus: 5 },
  ],
  // Absolute VM-minima per pad/fase
  VM_MIN: {
    RADAR: 0.06,
    BUILDUP: 0.09,
    ALMOST: 0.12,
    ELITE_EXPANSION: 0.16,
    ELITE_IGNITION: 0.12,
  },
  // Drempels voor expansie-pad (bull)
  EXPANSION: {
    RADAR:  { chg24:  5, chg1h:  1 },
    BUILDUP: { chg24:  9, chg1h:  1.8 },
    ALMOST:  { chg24: 15, chg1h:  2.8 },
    ELITE:   { chg24: 20, chg1h:  4 },
  },
  // Drempels voor ontstekings-pad (bull)
  IGNITION: {
    RADAR:   { chg24: 2.5, chg1h: 1.5, volAcc: 1.1 },
    BUILDUP: { chg24: 4,   chg1h: 2.2, volAcc: 1.2 },
    ALMOST:  { chg24: 6,   chg1h: 3,   volAcc: 1.3 },
    ELITE:   { chg24: 9,   chg1h: 4,   volAcc: 1.4 },
  },
  // Drempels voor expansie-pad (bear)
  BEAR_EXPANSION: {
    RADAR:  { chg24: -5, chg1h: -1 },
    BUILDUP: { chg24: -9, chg1h: -1.8 },
    ALMOST:  { chg24: -15, chg1h: -2.8 },
    ELITE:   { chg24: -20, chg1h: -4 },
  },
  // Drempels voor instorting-pad (bear)
  BEAR_IGNITION: {
    RADAR:   { chg24: -2.5, chg1h: -1.5, volAcc: 1.1 },
    BUILDUP: { chg24: -4,   chg1h: -2.2, volAcc: 1.2 },
    ALMOST:  { chg24: -6,   chg1h: -3,   volAcc: 1.3 },
    ELITE:   { chg24: -9,   chg1h: -4,   volAcc: 1.4 },
  },
  // Volume‑acceleratie (korte en medium termijn)
  VOL_ACC: {
    SHORT_WINDOW: 5,
    MEDIUM_WINDOW: 20,
    RADAR:   { short: 1.08, medium: 1.05 },
    BUILDUP: { short: 1.15, medium: 1.10 },
    ALMOST:  { short: 1.25, medium: 1.15 },
    ELITE:   { short: 1.40, medium: 1.25 },
  },
  // Orderbook‑drempels per tier (adaptief)
  OB: {
    small:    { spreadMax: 2.0, depthMinRatio: 0.45, obScoreMin: 0.01 },
    mid:      { spreadMax: 1.5, depthMinRatio: 0.60, obScoreMin: 0.015 },
    upperMid: { spreadMax: 1.0, depthMinRatio: 0.70, obScoreMin: 0.02 },
    large:    { spreadMax: 0.7, depthMinRatio: 0.80, obScoreMin: 0.025 },
  },
  // Compressie‑detectie
  COMPRESSION: {
    MAX_FLAT_PCT: 8,           // max range in % over 60 candles
    MIN_SQUEEZE_DAYS: 10,      // minimaal aantal dagen van compressie
  },
  // Asymmetrie‑factor (geschatte move‑potentie o.b.v. market cap)
  ASYMMETRY_FACTOR: 0.0002,
};

// Depth‑factor (wordt later in hybride berekening gebruikt)
export const depthK = 0.00025;

// Tiers (blijven zoals ze waren, maar worden adaptief gebruikt)
export const TIERS = [
  { name: "small",     marketCapMax: 100_000_000, depthMinUsd: 1_000 },
  { name: "mid",       marketCapMax: 500_000_000, depthMinUsd: 4_000 },
  { name: "upper-mid", marketCapMax: 2_000_000_000, depthMinUsd: 12_000 },
  { name: "large",     marketCapMax: Infinity,     depthMinUsd: 50_000 },
];

// Blokkadelijst (uitgebreid met synthetische/leveraged rommel)
const BLOCKED_SYMBOLS = [
  "USDT", "BUSD", "DAI", "USDC", "TUSD", "PAX", "UST", "LUNC", "LUNA",
  "USTC", "LUNA2", "MIM", "FRAX", "WBTC", "WETH", "renBTC",
  "3X", "BEAR", "BULL", "DOWN", "UP", "HEDGE",
];

// ---------- Hulpfuncties ----------
export function isBlockedMoonAsset(coin) {
  if (!coin || !coin.symbol) return true;
  const sym = coin.symbol.toUpperCase();
  if (BLOCKED_SYMBOLS.some(b => sym.includes(b))) return true;
  if (sym.endsWith("USD") || sym.endsWith("EUR")) return true;
  return false;
}

export function getTierForMcap(mcap) {
  for (const tier of TIERS) {
    if (mcap < tier.marketCapMax) return tier;
  }
  return TIERS[TIERS.length - 1];
}

// Hybride depth‑vloer (max van tier min, mcap*factor, en mediaan van eigen depth)
// We gebruiken hier een vereenvoudigde versie zonder historische mediaan
export function depthFloorUsd(mcap, tier, depthHist = []) {
  const factor = tier === TIERS[0] ? 0.8 : tier === TIERS[1] ? 1.0 : tier === TIERS[2] ? 1.5 : 2.0;
  const base = Math.max(tier.depthMinUsd, Math.round(depthK * Math.sqrt(mcap) * factor));
  // Als er een diepte‑historie is, nemen we 70% van de mediaan mee
  if (depthHist.length > 0) {
    const sorted = [...depthHist].sort((a,b) => a-b);
    const median = sorted[Math.floor(sorted.length/2)];
    return Math.max(base, Math.round(median * 0.7));
  }
  return base;
}

// ---------- Modules voor confidence ----------

// Berekent VM‑expansie (huidige VM / mediaan VM)
function computeVmExpansion(currentVm, vmHist) {
  if (!vmHist || vmHist.length < 5) return 1;
  const median = vmHist.sort((a,b)=>a-b)[Math.floor(vmHist.length/2)];
  return median > 0 ? currentVm / median : 1;
}

// Berekent volume‑acceleratie voor twee vensters
function computeVolumeAcceleration(volHist) {
  const short = MOON_V3.VOL_ACC.SHORT_WINDOW;
  const medium = MOON_V3.VOL_ACC.MEDIUM_WINDOW;
  if (volHist.length < medium) return { short: 1, medium: 1 };
  const now = volHist[volHist.length-1];
  const shortAgo = volHist[volHist.length-1-short] || now;
  const mediumAgo = volHist[volHist.length-1-medium] || now;
  return {
    short: now / Math.max(shortAgo, 1e-9),
    medium: now / Math.max(mediumAgo, 1e-9),
  };
}

// Detecteert compressie (vlakheid en squeezelengte)
function detectCompression(priceHist) {
  if (priceHist.length < 30) return { isCompressed: false, flatPct: 100 };
  const recent = priceHist.slice(-60);
  const max = Math.max(...recent);
  const min = Math.min(...recent);
  const flatPct = ((max - min) / ((max + min)/2)) * 100;
  const isCompressed = flatPct < MOON_V3.COMPRESSION.MAX_FLAT_PCT;
  return { isCompressed, flatPct };
}

// Geeft OB‑drempels op basis van tier
function getObThresholds(tierName) {
  return MOON_V3.OB[tierName] || MOON_V3.OB.mid;
}

// Expansion‑score (0-100)
function computeExpansionScore(coin, mode, btc, volAcc) {
  let score = 0;
  const abs24 = Math.abs(coin.change24);
  const abs1h = Math.abs(coin.change1h);
  // momentum
  if (mode === 'bull') {
    score += Math.min(40, abs24 * 2);
    score += Math.min(30, abs1h * 5);
  } else {
    score += Math.min(40, abs24 * 2);
    score += Math.min(30, abs1h * 5);
  }
  // volume acceleratie
  score += Math.min(20, (volAcc.medium - 1) * 100);
  // VM
  score += Math.min(20, coin.vm * 80);
  // BTC alignment
  if ((mode === 'bull' && btc.state === 'BULL') || (mode === 'bear' && btc.state === 'BEAR')) {
    score += 10;
  } else if (btc.state === 'NEUTRAL') {
    score += 5;
  }
  return Math.min(100, score);
}

// Ignition‑score (0-100) – focust op vroege breakout
function computeIgnitionScore(coin, mode, btc, volAcc, compression) {
  let score = 0;
  const abs24 = Math.abs(coin.change24);
  const abs1h = Math.abs(coin.change1h);
  // momentum (minder zwaar dan expansion)
  score += Math.min(25, abs24 * 1.5);
  score += Math.min(25, abs1h * 4);
  // volume acceleratie (korte termijn extra)
  score += Math.min(20, (volAcc.short - 1) * 150);
  // compressiebonus
  if (compression.isCompressed) {
    score += 20;
  }
  // VM expansie (stijgende VM)
  if (coin.vmExpansion > 1.2) score += 15;
  // BTC neutraal of aligned
  if (btc.state !== (mode === 'bull' ? 'BEAR' : 'BULL')) score += 5;
  return Math.min(100, score);
}

// Liquiditeitsscore (0-100) – of de move tradeable is
function computeLiquidityScore(coin, obx, tier) {
  let score = 0;
  const th = getObThresholds(tier.name);
  // spread
  if (obx.spreadPct <= th.spreadMax) score += 30;
  else if (obx.spreadPct <= th.spreadMax * 1.5) score += 15;
  // depth
  const depthRatio = obx.depthMinUsd1p / Math.max(coin.marketCap * 0.001, 1);
  if (depthRatio > 0.5) score += 30;
  else if (depthRatio > 0.2) score += 15;
  // ob score
  if (obx.score >= th.obScoreMin) score += 20;
  else if (obx.score >= th.obScoreMin * 0.5) score += 10;
  // lor (grootste order ratio) – hoge lor is riskant
  if (obx.lor < 0.7) score += 20;
  else if (obx.lor < 0.9) score += 10;
  return Math.min(100, score);
}

// Asymmetriescore (marktkap‑efficiëntie)
function computeAsymmetryScore(mcap) {
  for (const bracket of MOON_V3.MCAP_BONUS) {
    if (mcap <= bracket.max) return bracket.bonus;
  }
  return 0;
}

// BTC‑alignment score (‑20 tot +20)
function computeBTCAlignmentScore(mode, btc) {
  if (mode === 'bull') {
    if (btc.state === 'BULL') return 20;
    if (btc.state === 'NEUTRAL') return 5;
    return -10;
  } else {
    if (btc.state === 'BEAR') return 20;
    if (btc.state === 'NEUTRAL') return 5;
    return -10;
  }
}

// ---------- Confidence (hoofdberekening) ----------
export function computeConfidence({
  coin, mode, btc, obx, volAcc, compression, vmExpansion, mcap
}) {
  const expScore = computeExpansionScore(coin, mode, btc, volAcc);
  const ignScore = computeIgnitionScore(coin, mode, btc, volAcc, compression);
  const liqScore = computeLiquidityScore(coin, obx, getTierForMcap(mcap));
  const asymScore = computeAsymmetryScore(mcap);
  const btcScore = computeBTCAlignmentScore(mode, btc);

  // Weegfactoren (expansie en ontsteking kunnen verschillen per fase)
  const confidence = expScore * 0.4 + ignScore * 0.3 + liqScore * 0.15 + asymScore * 0.1 + btcScore * 0.05;
  return Math.max(20, Math.min(98, Math.round(confidence)));
}

// ---------- Poortfuncties (adaptief per pad) ----------
function meetsExpansion(coin, mode, stage) {
  const cfg = mode === 'bull' ? MOON_V3.EXPANSION[stage] : MOON_V3.BEAR_EXPANSION[stage];
  if (!cfg) return false;
  if (mode === 'bull') {
    if (coin.change24 < cfg.chg24) return false;
    if (coin.change1h < cfg.chg1h) return false;
  } else {
    if (coin.change24 > cfg.chg24) return false; // negatief
    if (coin.change1h > cfg.chg1h) return false;
  }
  return true;
}

function meetsIgnition(coin, mode, stage, volAcc) {
  const cfg = mode === 'bull' ? MOON_V3.IGNITION[stage] : MOON_V3.BEAR_IGNITION[stage];
  if (!cfg) return false;
  if (mode === 'bull') {
    if (coin.change24 < cfg.chg24) return false;
    if (coin.change1h < cfg.chg1h) return false;
  } else {
    if (coin.change24 > cfg.chg24) return false;
    if (coin.change1h > cfg.chg1h) return false;
  }
  if (volAcc.short < cfg.volAcc) return false;
  return true;
}

// RADAR: minimale instap
export function passRadarMoon(coin, mode, btc) {
  if (!coin) return false;
  if (isBlockedMoonAsset(coin)) return false;
  if (coin.volume < 300_000) return false;
  if (coin.marketCap < 1_500_000 || coin.marketCap > 180_000_000) return false;
  if (coin.vm < MOON_V3.VM_MIN.RADAR) return false;

  // BTC mag tegenwerken, maar geeft straf via confidence, geen harde block
  return true;
}

// BUILDUP: ofwel expansion, ofwel ignition met volume acceleratie
export function passBuildupMoon({ c, volAcc, confidence }) {
  if (!c) return { ok: false, why: "no_coin" };
  if (confidence < 40) return { ok: false, why: "low_confidence" };
  // VM check
  if (c.vm < MOON_V3.VM_MIN.BUILDUP) return { ok: false, why: "low_vm" };
  // Minimaal één pad moet voldoen
  const expOk = meetsExpansion(c, 'bull', 'BUILDUP'); // mode wordt dynamisch gemaakt
  const ignOk = meetsIgnition(c, 'bull', 'BUILDUP', volAcc);
  if (!expOk && !ignOk) return { ok: false, why: "no_momentum" };
  return { ok: true, path: expOk ? 'expansion' : 'ignition' };
}

// ALMOST: strenger
export function passAlmostMoon({ c, volAcc, confidence, compression }) {
  if (!c) return { ok: false, why: "no_coin" };
  if (confidence < 55) return { ok: false, why: "low_confidence" };
  if (c.vm < MOON_V3.VM_MIN.ALMOST) return { ok: false, why: "low_vm" };
  const expOk = meetsExpansion(c, 'bull', 'ALMOST');
  const ignOk = meetsIgnition(c, 'bull', 'ALMOST', volAcc);
  if (!expOk && !ignOk) return { ok: false, why: "no_momentum" };
  // compressie is bonus, maar niet verplicht
  return { ok: true, path: expOk ? 'expansion' : 'ignition' };
}

// ELITE: twee aparte uitgangen
export function passEliteMoon({ mode, c, obView, volAcc, confidence, depthUsd, floorUsd, tier }) {
  if (!c) return { ok: false, why: "no_coin", eliteType: null };
  if (confidence < 70) return { ok: false, why: "low_confidence", eliteType: null };
  // VM
  if (c.vm < MOON_V3.VM_MIN.ELITE_EXPANSION) return { ok: false, why: "low_vm", eliteType: null };

  const obTh = getObThresholds(tier.name);
  // Algemene OB sanity (beide paden moeten minimaal voldoen)
  if (obView.spreadPct > obTh.spreadMax * 1.5) return { ok: false, why: "spread_too_high", eliteType: null };
  if (obView.lor > 0.95) return { ok: false, why: "lor_too_high", eliteType: null };
  if (depthUsd < floorUsd * 0.3) return { ok: false, why: "depth_too_low", eliteType: null };

  // Controleer expansion pad
  const expOk = meetsExpansion(c, mode, 'ELITE');
  // Controleer ignition pad
  const ignOk = meetsIgnition(c, mode, 'ELITE', volAcc);

  if (expOk) {
    // Expansion vereist iets strengere OB
    if (obView.spreadPct > obTh.spreadMax) return { ok: false, why: "expansion_spread", eliteType: null };
    if (obView.score < obTh.obScoreMin) return { ok: false, why: "expansion_obscore", eliteType: null };
    if (depthUsd < floorUsd * obTh.depthMinRatio) return { ok: false, why: "expansion_depth", eliteType: null };
    return { ok: true, eliteType: 'EXPANSION' };
  }
  if (ignOk) {
    // Ignition mag iets soepeler
    if (obView.spreadPct > obTh.spreadMax * 1.2) return { ok: false, why: "ignition_spread", eliteType: null };
    if (obView.score < obTh.obScoreMin * 0.7) return { ok: false, why: "ignition_obscore", eliteType: null };
    if (depthUsd < floorUsd * obTh.depthMinRatio * 0.8) return { ok: false, why: "ignition_depth", eliteType: null };
    return { ok: true, eliteType: 'IGNITION' };
  }
  return { ok: false, why: "no_elite_path", eliteType: null };
}

// ---------- Risico & Tradeplan (ongewijzigd) ----------
export function computeMoonRisk({ mode, price, range24, confidence, depthOk, tier }) {
  if (!price || price <= 0) return null;
  const atrFactor = Math.min(0.15, Math.max(0.02, range24 / price || 0.02));
  const baseSlPct = mode === "bull" ? 0.06 : 0.05;
  const baseTpPct = mode === "bull" ? 0.15 : 0.12;

  let slPct = baseSlPct + atrFactor * 0.5;
  let tpPct = baseTpPct + atrFactor * 1.5;

  if (confidence > 80) {
    tpPct *= 1.2;
  } else if (confidence < 50) {
    slPct *= 1.1;
  }

  const sl = mode === "bull" ? price * (1 - slPct) : price * (1 + slPct);
  const tp3 = mode === "bull" ? price * (1 + tpPct) : price * (1 - tpPct);

  return { sl, tp3, slPct, tpPct };
}

export function calcPnlPct({ mode, entryPrice, priceNow }) {
  if (!entryPrice || entryPrice <= 0) return 0;
  if (mode === "bull") {
    return ((priceNow - entryPrice) / entryPrice) * 100;
  } else {
    return ((entryPrice - priceNow) / entryPrice) * 100;
  }
}

export function hitStopOrTp({ mode, priceNow, sl, tp3 }) {
  if (mode === "bull") {
    if (priceNow <= sl) return { hit: true, kind: "SL" };
    if (priceNow >= tp3) return { hit: true, kind: "TP" };
  } else {
    if (priceNow >= sl) return { hit: true, kind: "SL" };
    if (priceNow <= tp3) return { hit: true, kind: "TP" };
  }
  return { hit: false };
}

// ---------- Data‐ophaling (ongewijzigd) ----------
export async function getBitgetSpotUsdtSymbols() {
  try {
    const r = await fetch("https://api.bitget.com/api/v2/spot/public/symbols");
    if (!r.ok) {
      console.error("Bitget symbols HTTP error:", r.status);
      return new Set();
    }
    const json = await r.json();
    if (String(json?.code || "") !== "00000") {
      console.error("Bitget symbols API error:", json);
      return new Set();
    }
    const set = new Set();
    for (const s of json.data || []) {
      const status = String(s?.status || "").toLowerCase();
      const quoteCoin = String(s?.quoteCoin || "").toUpperCase();
      const baseCoin = String(s?.baseCoin || "").toUpperCase();
      if (status !== "online") continue;
      if (quoteCoin !== "USDT") continue;
      if (!baseCoin) continue;
      set.add(baseCoin);
    }
    console.log("Bitget USDT base symbols loaded:", set.size);
    return set;
  } catch (e) {
    console.error("getBitgetSpotUsdtSymbols error:", e);
    return new Set();
  }
}

export async function fetchCoinGeckoTopCached() {
  try {
    const r = await fetch(
      "https://api.coingecko.com/api/v3/coins/markets?" +
      new URLSearchParams({
        vs_currency: "usd",
        order: "volume_desc",
        per_page: "250",
        page: "1",
        sparkline: "false",
        price_change_percentage: "1h,24h",
      })
    );
    if (!r.ok) throw new Error("CoinGecko fetch failed");
    const data = await r.json();
    return data.map((c) => {
      const marketCap = Number(c.market_cap || 0);
      const volume = Number(c.total_volume || 0);
      const high24 = Number(c.high_24h || 0);
      const low24 = Number(c.low_24h || 0);
      const range24 = high24 > 0 && low24 > 0
        ? ((high24 - low24) / ((high24 + low24) / 2)) * 100
        : 0;
      return {
        id: c.id,
        symbol: String(c.symbol || "").toUpperCase(),
        name: c.name || "",
        image: c.image || "",
        price: Number(c.current_price || 0),
        marketCap,
        volume,
        change24: Number(c.price_change_percentage_24h || 0),
        change1h: Number(c.price_change_percentage_1h_in_currency || 0),
        vm: marketCap > 0 ? volume / marketCap : 0,
        range24,
      };
    });
  } catch (e) {
    console.error("fetchCoinGeckoTopCached error", e);
    return [];
  }
}

export async function fetchBTCGateCached() {
  try {
    const r = await fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT");
    if (!r.ok) throw new Error("Gate io BTC fetch failed");
    const data = await r.json();
    const ticker = Array.isArray(data) ? data[0] : null;
    if (!ticker) throw new Error("No BTC ticker");
    const price = Number(ticker.last || 0);
    const chg24 = Number(ticker.change_percentage || 0);
    const high = Number(ticker.high_24h || 0);
    const low = Number(ticker.low_24h || 0);
    const range24 = high > 0 && low > 0
      ? ((high - low) / ((high + low) / 2)) * 100
      : 0;
    const state = chg24 >= 1 ? "BULL" : chg24 <= -1 ? "BEAR" : "NEUTRAL";
    return { price, chg24, chg1h: 0, range24, state };
  } catch (e) {
    console.error("fetchBTCGateCached error", e);
    return { price: 0, chg24: 0, chg1h: 0, range24: 0, state: "NEUTRAL" };
  }
}

export const fetchBTCGateFromUniverse = fetchBTCGateCached;

// ---------- KV‐sleutels ----------
export function keyMoonLatest(mode) { return `moon:latest:${mode}`; }
export function keyMoonPortfolio(mode) { return `moon:portfolio:${mode}`; }
export function keyMoonPositions(mode) { return `moon:positions:${mode}`; }
export function keyMoonState(mode) { return `moon:state:${mode}`; }

// ---------- Authenticatie ----------
export function requireSecret(req, res) {
  const token = req.query?.token || req.headers?.authorization?.replace("Bearer ", "");
  if (token === process.env.CRON_SECRET) return true;
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
  return false;
}