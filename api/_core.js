// /api/_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs20.x" };

// ================== SETTINGS (v1 + upgrades) ==================
export const SETTINGS = {
  // Universe
  CG_TOP: 250,
  RADAR_LIMIT: 160,

  // RADAR (breed)
  mcapMin: 5_000_000,
  mcapMax: 400_000_000,
  volMinRadar: 500_000,
  vmMinRadar: 0.15,
  maxAbsChg24: 35,
  maxRange24: 30,

  // BTC gate
  btcChgGate: 0.8, // +/- 0.8%
  btcRangeMin: 2,
  btcRangeMaxBull: 8,
  btcRangeMaxBear: 10,

  // volatility knob (light): coin range cap beweegt mee met btcRange
  coinRangeCapMin: 25,
  coinRangeCapMax: 40,

  // BUILDUP
  buildup: { chgMin: 1.2, vmMin: 0.22, volMin: 1_200_000 },

  // ALMOST
  almost: { vmMin: 0.26, volMin: 2_000_000, priceFlatMax: 6.5 },

  // ENTRY (OB gate)
  entry: {
    obScoreMin: 0.06,     // bull >= 0.06, bear <= -0.06
    spreadMaxPct: 0.55,   // %
    largestOrderRatioMax: 0.35,
    samplesNeed: 3,
    samplesWindowSec: 90,
    minAgree: 2           // 2/3 richting
  },

  // No-skip
  minScansPerStage: 2,

  // consistency window based
  consistencyWindowMin: 120, // 2 uur
  consistencyMinRatio: 0.67, // 67%
  consistencyMinSamples: 6,

  // OB sampler selection
  obPickAlmost: 12,
  obPickBuildup: 8
};

// ================== AUTH ==================
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

// ================== KV KEYS ==================
export const keyLatest = (mode) => `latest:${mode}`;
export const keyState  = (mode) => `state:${mode}`;
export const keyReset  = (mode) => `resetAt:${mode}`;
export const keyBitgetSymbols = "bitget:symbols:spotusdt";

export const keyObSamples = (side, symbol) => `ob:samples:${side}:${symbol}`;
export const keyObResult  = (side, symbol) => `ob:result:${side}:${symbol}`;

export const keyEntryLog = "log:entry"; // list (best effort)

// ================== DISCORD ==================
export async function sendDiscord(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {
    // discord mag scan niet slopen
  }
}

export function webhookForStage(stage) {
  if (stage === "RADAR")  return process.env.DISCORD_WEBHOOK_RADAR;
  if (stage === "BUILDUP")return process.env.DISCORD_WEBHOOK_BUILDUP;
  if (stage === "ALMOST") return process.env.DISCORD_WEBHOOK_ALMOST;
  if (stage === "ENTRY")  return process.env.DISCORD_WEBHOOK_ENTRY;
  return null;
}

export function fmtCoinLine(c, mode, stage, extra = "") {
  const base = "https://cryptocroc-scanner-omega.vercel.app";
  const page = `${base}/?mode=${encodeURIComponent(mode)}`;
  const lines = [
    `**${c.symbol}** → **${stage}** (${mode.toUpperCase()})`,
    `prijs: $${num(c.price)} | chg24: ${sign(c.change24)}% | range24: ${num(c.range24)}%`,
    `vol: $${short(c.volume)} | mc: $${short(c.marketCap)} | vm: ${num(c.vm)}`,
  ];
  if (extra) lines.push(extra);
  lines.push(`open: ${page}`);
  return lines.join("\n");
}

// ================== DATA FETCH ==================
export async function fetchCoinGeckoTop() {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?` +
    `vs_currency=usd&order=market_cap_desc&per_page=${SETTINGS.CG_TOP}&page=1` +
    `&sparkline=false&price_change_percentage=24h`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko markets failed ${r.status}`);
  const arr = await r.json();

  return arr.map((x) => normalizeCG(x));
}

export async function fetchBTCGate() {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&sparkline=false&price_change_percentage=24h`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko BTC failed ${r.status}`);
  const [x] = await r.json();

  const btc = normalizeCG(x);
  const chg24 = btc.change24;
  const range24 = btc.range24;

  const bull =
    chg24 >= SETTINGS.btcChgGate &&
    range24 >= SETTINGS.btcRangeMin &&
    range24 <= SETTINGS.btcRangeMaxBull;

  const bear =
    chg24 <= -SETTINGS.btcChgGate &&
    range24 >= SETTINGS.btcRangeMin &&
    range24 <= SETTINGS.btcRangeMaxBear;

  let state = "NEUTRAL";
  if (bull) state = "BULL";
  else if (bear) state = "BEAR";

  return { state, chg24, range24 };
}

function normalizeCG(x) {
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

// ================== MINI-UPGRADES ==================
// median spike guard op volume/range/vm + light guard op change24
export function applySpikeGuard(prevMetrics, cur) {
  // prevMetrics = { vol:[..], range:[..], vm:[..], chg:[..] } arrays max 3
  const m = prevMetrics || { vol: [], range: [], vm: [], chg: [] };

  const vol = guarded("vol", m.vol, cur.volume);
  const range = guarded("range", m.range, cur.range24);
  const vm = guarded("vm", m.vm, cur.vm);

  // change24: alleen spike guard (niet smoothen)
  const chg = guarded("chg", m.chg, cur.change24, { onlySpike: true });

  const next = {
    vol: push3(m.vol, vol),
    range: push3(m.range, range),
    vm: push3(m.vm, vm),
    chg: push3(m.chg, chg),
  };

  const patched = {
    ...cur,
    volume: vol,
    range24: range,
    vm: vm,
    change24: chg,
  };

  return { patched, nextMetrics: next };
}

function guarded(kind, arr, value, opts = {}) {
  const v = Number(value || 0);
  const a = Array.isArray(arr) ? arr.filter(Number.isFinite) : [];
  if (a.length < 2) return v;

  const med = median(a);
  if (!Number.isFinite(med) || med === 0) return v;

  // afwijking > 100% van mediaan => use median
  const diff = Math.abs(v - med) / Math.abs(med);
  if (diff > 1.0) {
    // voor change24 willen we geen smooth, alleen extreme spikes
    if (opts.onlySpike) return med;
    return med;
  }
  return v;
}

function push3(arr, v) {
  const a = Array.isArray(arr) ? arr.slice(-2) : [];
  a.push(Number(v || 0));
  return a;
}

function median(a) {
  const b = [...a].sort((x, y) => x - y);
  const mid = Math.floor(b.length / 2);
  return b.length % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
}

// consistency window: history = [{ts, side}] side = "BULL"/"BEAR"
export function updateSideHistory(prevHist, side) {
  const now = Date.now();
  const h = Array.isArray(prevHist) ? prevHist.slice(-60) : []; // hard cap
  h.push({ ts: now, side });
  return pruneSideHistory(h);
}

export function pruneSideHistory(hist) {
  const cutoff = Date.now() - SETTINGS.consistencyWindowMin * 60 * 1000;
  return (hist || []).filter((x) => Number(x?.ts || 0) >= cutoff);
}

export function calcConsistency(hist, wantedSide) {
  const h = pruneSideHistory(hist);
  const total = h.length;
  if (total < SETTINGS.consistencyMinSamples) return { ok: false, ratio: 0, total, same: 0 };
  const same = h.filter((x) => x.side === wantedSide).length;
  const ratio = total > 0 ? same / total : 0;
  return { ok: ratio >= SETTINGS.consistencyMinRatio, ratio, total, same };
}

// dynamic range cap based on btcRange
export function coinRangeCapFromBTC(btcRange24) {
  // 30% + (btcRange24 - 5) * 2, clamp 25..40
  const raw = 30 + (Number(btcRange24 || 0) - 5) * 2;
  return clamp(raw, SETTINGS.coinRangeCapMin, SETTINGS.coinRangeCapMax);
}

// ================== FILTERS ==================
export function passRadar(c, btcRange24) {
  const dynRangeCap = coinRangeCapFromBTC(btcRange24);

  if (c.marketCap < SETTINGS.mcapMin) return false;
  if (c.marketCap > SETTINGS.mcapMax) return false;
  if (c.volume < SETTINGS.volMinRadar) return false;
  if (c.vm < SETTINGS.vmMinRadar) return false;
  if (Math.abs(c.change24) > SETTINGS.maxAbsChg24) return false;
  if (c.range24 > Math.min(SETTINGS.maxRange24, dynRangeCap)) return false;
  return true;
}

export function passBuildup(c, mode, consistencyOk) {
  if (!consistencyOk) return false;

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

export function passAlmost(c, mode, priceHist, consistencyOk) {
  if (!passBuildup(c, mode, consistencyOk)) return false;
  if (c.vm < SETTINGS.almost.vmMin) return false;
  if (c.volume < SETTINGS.almost.volMin) return false;
  if (!priceFlatOk(priceHist, SETTINGS.almost.priceFlatMax)) return false;
  return true;
}

// ENTRY gate based on OB result + spread/lor + thresholds
export function passEntryFromOb(ob, mode) {
  if (!ob || !ob.valid) return { ok: false, why: "OB validating" };
  if (ob.stale) return { ok: false, why: "OB stale" };

  const score = Number(ob.score ?? ob.avgScore ?? 0);
  const spreadPct = Number(ob.spreadPct ?? 999);
  const lor = Number(ob.lor ?? 1);

  if (lor > SETTINGS.entry.largestOrderRatioMax) return { ok: false, why: "OB suspicious (largest order)" };
  if (spreadPct > SETTINGS.entry.spreadMaxPct) return { ok: false, why: "Spread too wide" };

  if (mode === "bull") {
    if (score < SETTINGS.entry.obScoreMin) return { ok: false, why: "OB score too low" };
  } else {
    if (score > -SETTINGS.entry.obScoreMin) return { ok: false, why: "OB score too low" };
  }

  return { ok: true, why: "OB gate passed" };
}

// Stage target (desired)
export function nextDesiredStage(c, mode, priceHist, consistencyOk, btcRange24, obGateOk) {
  if (!passRadar(c, btcRange24)) return "OUT";
  if (obGateOk) return "ENTRY";
  if (passAlmost(c, mode, priceHist, consistencyOk)) return "ALMOST";
  if (passBuildup(c, mode, consistencyOk)) return "BUILDUP";
  return "RADAR";
}

export function stageRank(stage) {
  if (stage === "RADAR") return 1;
  if (stage === "BUILDUP") return 2;
  if (stage === "ALMOST") return 3;
  if (stage === "ENTRY") return 4;
  return 0;
}

// ================== CONFIDENCE + SL/TP ==================
export function computeConfidence({ mode, obScore, obAgree, vm, volAcc, btc }) {
  // weights: OB 40, VM 20, VolAcc 20, BTC 20
  const obStrength = clamp01(mapLinear(Math.abs(obScore), 0.04, 0.20)); // 0..1
  const obBonus = obAgree === 3 ? 1.0 : obAgree === 2 ? 0.85 : 0.6;
  const ob = obStrength * obBonus;

  const vmStrength = clamp01(mapLinear(vm, SETTINGS.buildup.vmMin, 0.40));
  const vaStrength = clamp01(mapLinear(volAcc, 1.0, 1.25));
  const btcStrength = clamp01(mapLinear(Math.abs(btc?.chg24 || 0), SETTINGS.btcChgGate, 2.5));

  const score =
    40 * ob +
    20 * vmStrength +
    20 * vaStrength +
    20 * btcStrength;

  return Math.round(clamp(score, 0, 100));
}

export function computeAtrPctFromPriceHist(priceHist) {
  // simpele ATR proxy: avg abs return over laatste 6 scans (~1 uur)
  if (!Array.isArray(priceHist) || priceHist.length < 3) return 0.01; // 1% fallback
  let sum = 0;
  let n = 0;
  for (let i = 1; i < priceHist.length; i++) {
    const a = Number(priceHist[i - 1] || 0);
    const b = Number(priceHist[i] || 0);
    if (a > 0 && b > 0) {
      sum += Math.abs(b - a) / a;
      n++;
    }
  }
  const avg = n ? sum / n : 0.01;
  return clamp(avg, 0.002, 0.12); // 0.2% .. 12%
}

export function computeSLTP({ mode, price, atrPct }) {
  const atr = price * atrPct;
  const slDist = 1.8 * atr;
  const tpDist = 3.0 * atr;

  if (mode === "bull") {
    return {
      sl: price - slDist,
      tp: price + tpDist,
    };
  } else {
    return {
      sl: price + slDist,
      tp: price - tpDist,
    };
  }
}

// ================== HELPERS ==================
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function clamp01(n){ return clamp(n, 0, 1); }
function mapLinear(x, a, b){
  if (b === a) return 0;
  return (Number(x || 0) - a) / (b - a);
}
function num(n) { return (Number(n) || 0).toFixed(2); }
function sign(n){ return `${n >= 0 ? "+" : ""}${num(n)}`; }
function short(n){
  n = Number(n)||0;
  if (n >= 1e9) return (n/1e9).toFixed(2)+"B";
  if (n >= 1e6) return (n/1e6).toFixed(2)+"M";
  if (n >= 1e3) return (n/1e3).toFixed(2)+"K";
  return n.toFixed(0);
}