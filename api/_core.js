// /api/_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ====== BASIS SETTINGS (v1 defaults + mini upgrades) ======
export const SETTINGS = {
  CG_TOP: 250,
  RADAR_LIMIT: 160,

  // Poolfilters (RADAR)
  mcapMin: 5_000_000,
  mcapMax: 400_000_000,
  volMinRadar: 500_000,
  vmMinRadar: 0.15,
  maxAbsChg24: 35,

  // BTC gate (minimal pro, geen pseudo-ATR)
  btcChgGate: 0.8,
  btcRangeMin: 2,
  btcRangeMax: 10, // boven dit = te wild -> neutral

  // Dynamic coin range cap knob
  coinRangeBase: 30,        // basis cap
  coinRangeMinClamp: 25,    // nooit strakker dan dit
  coinRangeMaxClamp: 40,    // nooit ruimer dan dit

  // Stage eisen
  buildup: { chgMin: 1.2, vmMin: 0.22, volMin: 1_200_000 },
  almost:  { vmMin: 0.26, volMin: 2_000_000, priceFlatMax: 6.5 },

  // “Geen overslaan” rule
  minScansPerStage: 2,

  // Consistency window (vast tijdsvenster)
  consistencyWindowMin: 120, // 2 uur
  consistencyMinRatio: 0.67,
  consistencyMinSamples: 6,

  // Spike-guard
  spikeMaxDeltaRatio: 1.0, // >100% afwijking van mediaan -> vervang door mediaan (vol/range/vm)
  changeGuardAbs: 8,       // change24: light guard (abs verschil > 8pp)
};

// ====== ORDERBOOK CFG (voor /api/orderbook.js) ======
export const CFG = {
  obStaleSec: 15,
};

// ====== DISCORD ======
export async function sendDiscord(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {
    // bewust stil: discord mag je scan niet slopen
  }
}

export function webhookForStage(stage) {
  if (stage === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;
  if (stage === "BUILDUP") return process.env.DISCORD_WEBHOOK_BUILDUP;
  if (stage === "ALMOST") return process.env.DISCORD_WEBHOOK_ALMOST;
  if (stage === "ENTRY") return process.env.DISCORD_WEBHOOK_ENTRY; // (later)
  return null;
}

export function fmtCoinLine(c, mode, stage, extra = {}) {
  const base = "https://cryptocroc-scanner-omega.vercel.app";
  const page = `${base}/?mode=${encodeURIComponent(mode)}`;
  const parts = [
    `**${c.symbol}** → **${stage}** (${mode.toUpperCase()})`,
    `prijs: $${num(c.price)} | chg24: ${sign(c.change24)}% | range24: ${num(c.range24)}%`,
    `vol: $${short(c.volume)} | mc: $${short(c.marketCap)} | vm: ${num(c.vm)}`,
  ];

  if (extra?.strength != null) parts.push(`strength: **${Math.round(extra.strength)}**/100`);
  if (extra?.consistency != null) parts.push(`consistency: ${(extra.consistency * 100).toFixed(0)}%`);

  parts.push(`open: ${page}`);
  return parts.join("\n");
}

// ====== AUTH ======
export function requireSecret(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;

  const auth = req.headers?.authorization || "";
  const token = req.query?.token ? String(req.query.token) : "";

  const ok = auth === `Bearer ${secret}` || token === secret;
  if (!ok) {
    res.statusCode = 401;
    res.setHeader?.("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }
  return true;
}

// ====== KV KEYS ======
export const keyLatest = (mode) => `latest:${mode}`;
export const keyState  = (mode) => `state:${mode}`;
export const keyReset  = (mode) => `resetAt:${mode}`;
export const keyBitgetSymbols = "bitget:symbols:spotusdt";

// ====== DATA FETCH ======
export async function fetchCoinGeckoTop() {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?` +
    `vs_currency=usd&order=market_cap_desc&per_page=${SETTINGS.CG_TOP}&page=1` +
    `&sparkline=false&price_change_percentage=24h`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko markets failed ${r.status}`);
  const arr = await r.json();

  return arr.map((x) => {
    const high = Number(x.high_24h || 0);
    const low  = Number(x.low_24h || 0);
    const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

    const volume = Number(x.total_volume || 0);
    const marketCap = Number(x.market_cap || 0);
    const vm = marketCap > 0 ? volume / marketCap : 0;

    return {
      id: x.id,
      symbol: String(x.symbol || "").toUpperCase(),
      name: x.name,
      price: Number(x.current_price || 0),
      change24: Number(x.price_change_percentage_24h || 0),
      range24,
      volume,
      marketCap,
      vm,
    };
  });
}

export async function fetchBTCGate() {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=false&price_change_percentage=24h`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko BTC failed ${r.status}`);
  const [x] = await r.json();

  const chg24 = Number(x.price_change_percentage_24h || 0);
  const high = Number(x.high_24h || 0);
  const low  = Number(x.low_24h || 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  // minimal-pro volatility knob
  let state = "NEUTRAL";
  if (range24 < SETTINGS.btcRangeMin) state = "NEUTRAL";
  else if (range24 > SETTINGS.btcRangeMax) state = "NEUTRAL";
  else {
    if (chg24 >= SETTINGS.btcChgGate) state = "BULL";
    else if (chg24 <= -SETTINGS.btcChgGate) state = "BEAR";
  }

  // dynamic coin range cap
  const dynamicMaxRange24 =
    clamp(
      SETTINGS.coinRangeBase + (range24 - 5) * 2,
      SETTINGS.coinRangeMinClamp,
      SETTINGS.coinRangeMaxClamp
    );

  return { state, chg24, range24, dynamicMaxRange24 };
}

export async function getBitgetSpotUsdtSymbols() {
  const cached = await kv.get(keyBitgetSymbols);
  if (Array.isArray(cached) && cached.length) return new Set(cached);

  const url = "https://api.bitget.com/api/v2/spot/public/symbols";
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Bitget symbols failed ${r.status}`);
  const j = await r.json();

  const list = (j?.data || [])
    .filter((s) => String(s?.quoteCoin || "").toUpperCase() === "USDT")
    .map((s) => String(s?.baseCoin || "").toUpperCase())
    .filter(Boolean);

  await kv.set(keyBitgetSymbols, list, { ex: 60 * 60 * 24 });
  return new Set(list);
}

// ====== SPIKE-GUARD (median fallback) ======
export function median3(a, b, c) {
  const arr = [a, b, c].filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!arr.length) return 0;
  return arr[Math.floor(arr.length / 2)];
}

// vol/range/vm: als >100% afwijking van median -> gebruik median
export function guardSpike(current, hist3, ratio = SETTINGS.spikeMaxDeltaRatio) {
  const h = Array.isArray(hist3) ? hist3.slice(-3) : [];
  if (h.length < 2) return current;

  const m = median3(h[h.length - 1], h[h.length - 2], current);
  const base = Math.max(1e-9, Math.abs(m));
  const delta = Math.abs(current - m) / base;

  if (delta > ratio) return m;
  return current;
}

// change24: light guard (niet smoothen, alleen extreme sprong afkappen)
export function guardChange24(current, hist3) {
  const h = Array.isArray(hist3) ? hist3.slice(-3) : [];
  if (h.length < 2) return current;
  const m = median3(h[h.length - 1], h[h.length - 2], current);
  if (Math.abs(current - m) > SETTINGS.changeGuardAbs) return m;
  return current;
}

// ====== CONSISTENCY WINDOW (2 uur, min 6 samples) ======
export function pruneWindow(list, nowMs, windowMin) {
  const wMs = windowMin * 60 * 1000;
  return (Array.isArray(list) ? list : []).filter((x) => x && (nowMs - Number(x.ts || 0)) <= wMs);
}

export function computeConsistency(dirHist, nowMs, windowMin, minSamples) {
  const pruned = pruneWindow(dirHist, nowMs, windowMin);
  const total = pruned.length;
  if (total < minSamples) return { ratio: null, total };
  const ok = pruned.filter((x) => x.ok === true).length;
  return { ratio: ok / total, total };
}

// ====== FILTERS ======
export function passRadar(c, btc) {
  if (c.marketCap < SETTINGS.mcapMin) return false;
  if (c.marketCap > SETTINGS.mcapMax) return false;
  if (c.volume < SETTINGS.volMinRadar) return false;
  if (c.vm < SETTINGS.vmMinRadar) return false;
  if (Math.abs(c.change24) > SETTINGS.maxAbsChg24) return false;

  const maxRange = btc?.dynamicMaxRange24 ?? SETTINGS.coinRangeBase;
  if (c.range24 > maxRange) return false;

  return true;
}

export function passBuildup(c, mode) {
  const chgOk =
    mode === "bull"
      ? c.change24 >= SETTINGS.buildup.chgMin
      : c.change24 <= -SETTINGS.buildup.chgMin;

  if (!chgOk) return false;
  if (c.vm < SETTINGS.buildup.vmMin) return false;
  if (c.volume < SETTINGS.buildup.volMin) return false;
  return true;
}

export function priceFlatOk(priceHist, maxPct) {
  if (!Array.isArray(priceHist) || priceHist.length < 2) return true;
  const min = Math.min(...priceHist);
  const max = Math.max(...priceHist);
  if (min <= 0) return true;
  const pct = ((max - min) / min) * 100;
  return pct <= maxPct;
}

export function passAlmost(c, mode, priceHist) {
  if (!passBuildup(c, mode)) return false;
  if (c.vm < SETTINGS.almost.vmMin) return false;
  if (c.volume < SETTINGS.almost.volMin) return false;
  if (!priceFlatOk(priceHist, SETTINGS.almost.priceFlatMax)) return false;
  return true;
}

// ====== STAGE LOGIC ======
export function nextDesiredStage(c, mode, priceHist, btc) {
  if (!passRadar(c, btc)) return "OUT";
  if (passAlmost(c, mode, priceHist)) return "ALMOST";
  if (passBuildup(c, mode)) return "BUILDUP";
  return "RADAR";
}

export function stageRank(stage) {
  if (stage === "RADAR") return 1;
  if (stage === "BUILDUP") return 2;
  if (stage === "ALMOST") return 3;
  if (stage === "ENTRY") return 4;
  return 0;
}

// ====== UI EXPLANATIONS ======
export function explainStage(c, mode, priceHist, btc, consistencyRatio) {
  // reasons = wat klopt al; missing = wat moet nog voor volgende stap
  const maxRange = btc?.dynamicMaxRange24 ?? SETTINGS.coinRangeBase;

  const reasons = [];
  const missing = [];

  // radar checks
  if (c.marketCap >= SETTINGS.mcapMin) reasons.push("mcap ≥ min"); else missing.push(`mcap ≥ ${short(SETTINGS.mcapMin)}`);
  if (c.marketCap <= SETTINGS.mcapMax) reasons.push("mcap ≤ max"); else missing.push(`mcap ≤ ${short(SETTINGS.mcapMax)}`);
  if (c.volume >= SETTINGS.volMinRadar) reasons.push("vol ≥ radar"); else missing.push(`vol ≥ ${short(SETTINGS.volMinRadar)}`);
  if (c.vm >= SETTINGS.vmMinRadar) reasons.push("vm ≥ radar"); else missing.push(`vm ≥ ${SETTINGS.vmMinRadar}`);
  if (Math.abs(c.change24) <= SETTINGS.maxAbsChg24) reasons.push("|chg24| ok"); else missing.push(`|chg24| ≤ ${SETTINGS.maxAbsChg24}%`);
  if (c.range24 <= maxRange) reasons.push("range24 ok"); else missing.push(`range24 ≤ ${maxRange.toFixed(1)}%`);

  // next targets
  const needBuildup = [];
  const chgNeed = mode === "bull" ? `chg24 ≥ +${SETTINGS.buildup.chgMin}%` : `chg24 ≤ -${SETTINGS.buildup.chgMin}%`;
  needBuildup.push(chgNeed);
  needBuildup.push(`vm ≥ ${SETTINGS.buildup.vmMin}`);
  needBuildup.push(`vol ≥ ${short(SETTINGS.buildup.volMin)}`);

  const needAlmost = [];
  needAlmost.push(...needBuildup);
  needAlmost.push(`vm ≥ ${SETTINGS.almost.vmMin}`);
  needAlmost.push(`vol ≥ ${short(SETTINGS.almost.volMin)}`);
  needAlmost.push(`priceFlat ≤ ${SETTINGS.almost.priceFlatMax}% (laatste 6)`);

  return { reasons, missing, needBuildup, needAlmost, consistencyRatio };
}

export function strengthScore(c, btc, consistencyRatio) {
  // simpele 0-100 score voor UI (geen risk-engine, puur “hoe sterk”)
  const vmN = clamp((c.vm - 0.10) / 0.30, 0, 1);         // 0.10->0, 0.40->1
  const volN = clamp((c.volume - 500_000) / 4_500_000, 0, 1);
  const chgN = clamp((Math.abs(c.change24) - 1) / 15, 0, 1);
  const consN = consistencyRatio == null ? 0.4 : clamp(consistencyRatio, 0, 1);
  const btcN = btc?.state === "BULL" || btc?.state === "BEAR" ? 1 : 0;

  // weging: vm 30, vol 25, chg 20, cons 15, btc 10
  return (
    vmN * 30 +
    volN * 25 +
    chgN * 20 +
    consN * 15 +
    btcN * 10
  );
}

// helpers
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function num(n) { return (Number(n) || 0).toFixed(2); }
function sign(n){ return `${n >= 0 ? "+" : ""}${num(n)}`; }
function short(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}