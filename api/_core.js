// /api/_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs20.x" };

// ================== SETTINGS (v1 + fases 0/1/2) ==================
export const SETTINGS = {
  // Universe
  CG_TOP: 500,
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
    minAgree: 2,          // 2/3 richting

    // ✅ NIEUW (Betrouwbaarheid): liquiditeitsvloer binnen 1%
    // min(bidUSD, askUSD) binnen 1% van mid moet minstens dit zijn
    minDepthUsd1p: 200_000,

    // Fase 1 hard gates
    minConfidence: 70,          // ENTRY alleen als conf >= 70
    entryConsistencyMin: 0.75,  // ENTRY alleen als consistency >= 75%

    // Fase 1 OB slope (alleen als samples bestaan)
    // bull: slope >= 0 (druk niet afnemend), bear: slope <= 0
    obSlopeEnabled: true,
    obSlopeMinBull: 0.0,
    obSlopeMaxBear: 0.0,
    obSlopeMinSamples: 3,
  },

  // No-skip
  minScansPerStage: 2,

  // consistency window based
  consistencyWindowMin: 120, // 2 uur
  consistencyMinRatio: 0.67, // 67% (voor BUILDUP/ALMOST)
  consistencyMinSamples: 6,

  // OB sampler selection (voor je OB-sampler job)
  obPickAlmost: 12,
  obPickBuildup: 8,

  // CG cache
  cgCacheSec: 60 * 10, // 10 minuten

  // Fase 2: Bitget ATR cache
  atrCacheSec: 60 * 10, // 10 minuten
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
export const keyState = (mode) => `state:${mode}`;
export const keyReset = (mode) => `resetAt:${mode}`;
export const keyBitgetSymbols = "bitget:symbols:spotusdt";

export const keyObSamples = (side, symbol) => `ob:samples:${side}:${symbol}`;
export const keyObResult = (side, symbol) => `ob:result:${side}:${symbol}`;

export const keyEntryLog = "log:entry"; // list (best effort)

// CG cache keys
const keyCgTopCache = `cache:cg:top:${SETTINGS.CG_TOP}`;
const keyCgBtcCache = `cache:cg:btc`;

// ATR cache key
const keyAtr1hCache = (symbol) => `cache:atr1h:${symbol}`;

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
  if (stage === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;
  if (stage === "BUILDUP") return process.env.DISCORD_WEBHOOK_BUILDUP;
  if (stage === "ALMOST") return process.env.DISCORD_WEBHOOK_ALMOST;
  if (stage === "ENTRY") return process.env.DISCORD_WEBHOOK_ENTRY;
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

// ================== DATA FETCH (CoinGecko + cache) ==================
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

export async function fetchCoinGeckoTopCached() {
  const cached = await kv.get(keyCgTopCache);
  if (Array.isArray(cached) && cached.length) return cached;

  const fresh = await fetchCoinGeckoTop();
  await kv.set(keyCgTopCache, fresh, { ex: SETTINGS.cgCacheSec });
  return fresh;
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

export async function fetchBTCGateCached() {
  const cached = await kv.get(keyCgBtcCache);
  if (cached && cached.state) return cached;

  const fresh = await fetchBTCGate();
  await kv.set(keyCgBtcCache, fresh, { ex: SETTINGS.cgCacheSec });
  return fresh;
}

function normalizeCG(x) {
  const high = Number(x.high_24h || 0);
  const low = Number(x.low_24h || 0);
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

// ================== FASE 2: Bitget ATR(14) op 1H candles (spot) ==================
export async function fetchBitgetAtr1hPctCached(symbolUpper) {
  const symbol = String(symbolUpper || "").toUpperCase();
  if (!symbol) return null;

  const k = keyAtr1hCache(symbol);
  const cached = await kv.get(k);
  if (cached && Number.isFinite(cached.atrPct)) return cached;

  const fresh = await fetchBitgetAtr1hPct(symbol);
  if (fresh && Number.isFinite(fresh.atrPct)) {
    await kv.set(k, fresh, { ex: SETTINGS.atrCacheSec });
  }
  return fresh;
}

async function fetchBitgetAtr1hPct(symbolUpper) {
  const sym = `${symbolUpper}USDT`;
  const url =
    `https://api.bitget.com/api/v3/market/candles?` +
    `category=SPOT&symbol=${encodeURIComponent(sym)}&interval=1H&type=MARKET&limit=20`;

  const j = await safeJsonFetch(url, 6500);
  if (!j || j.code !== "00000" || !Array.isArray(j.data) || j.data.length < 15) {
    return null;
  }

  const candles = j.data
    .map((row) => ({
      ts: Number(row?.[0] || 0),
      o: Number(row?.[1] || 0),
      h: Number(row?.[2] || 0),
      l: Number(row?.[3] || 0),
      c: Number(row?.[4] || 0),
    }))
    .filter((x) => x.ts > 0 && x.h > 0 && x.l > 0 && x.c > 0)
    .sort((a, b) => a.ts - b.ts);

  if (candles.length < 15) return null;

  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    if (Number.isFinite(tr) && tr > 0) trs.push(tr);
  }

  if (trs.length < 14) return null;

  const last14 = trs.slice(-14);
  const atr = last14.reduce((a, b) => a + b, 0) / last14.length;
  const lastClose = candles[candles.length - 1].c;
  const atrPct = lastClose > 0 ? atr / lastClose : null;

  if (!Number.isFinite(atrPct)) return null;

  return {
    atr: atr,
    atrPct: clamp(atrPct, 0.002, 0.20),
    close: lastClose,
    ts: Date.now(),
    source: "bitget1h",
  };
}

async function safeJsonFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ================== MINI-UPGRADES ==================
export function applySpikeGuard(prevMetrics, cur) {
  const m = prevMetrics || { vol: [], range: [], vm: [], chg: [] };

  const vol = guarded(m.vol, cur.volume);
  const range = guarded(m.range, cur.range24);
  const vm = guarded(m.vm, cur.vm);
  const chg = guarded(m.chg, cur.change24);

  const next = {
    vol: push3(m.vol, vol),
    range: push3(m.range, range),
    vm: push3(m.vm, vm),
    chg: push3(m.chg, chg),
  };

  const patched = { ...cur, volume: vol, range24: range, vm, change24: chg };
  return { patched, nextMetrics: next };
}

function guarded(arr, value) {
  const v = Number(value || 0);
  const a = Array.isArray(arr) ? arr.filter(Number.isFinite) : [];
  if (a.length < 2) return v;

  const med = median(a);
  if (!Number.isFinite(med) || med === 0) return v;

  const diff = Math.abs(v - med) / Math.abs(med);
  return diff > 1.0 ? med : v;
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

// consistency window
export function updateSideHistory(prevHist, side) {
  const now = Date.now();
  const h = Array.isArray(prevHist) ? prevHist.slice(-80) : [];
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
  const raw = 30 + (Number(btcRange24 || 0) - 5) * 2;
  return clamp(raw, SETTINGS.coinRangeCapMin, SETTINGS.coinRangeCapMax);
}

// ================== PRICE HISTORY + 1H CHANGE (FASE 1) ==================
export function updatePriceHist(prevPriceHist, price) {
  const now = Date.now();
  const hist = normalizePriceHist(prevPriceHist).slice(-80);
  hist.push({ ts: now, price: Number(price || 0) });
  return hist;
}

export function normalizePriceHist(prev) {
  if (!Array.isArray(prev)) return [];
  if (prev.length && typeof prev[0] === "number") {
    return prev
      .map((p, i) => ({ ts: Date.now() - (prev.length - i) * 10 * 60 * 1000, price: Number(p || 0) }))
      .filter((x) => x.price > 0);
  }
  return prev
    .map((x) => ({ ts: Number(x?.ts || 0), price: Number(x?.price || 0) }))
    .filter((x) => x.ts > 0 && x.price > 0);
}

export function calcChange1hPct(priceHist) {
  const h = normalizePriceHist(priceHist).sort((a, b) => a.ts - b.ts);
  const now = Date.now();
  const cutoff = now - 55 * 60 * 1000;
  const older = h.filter((x) => x.ts <= cutoff);
  const last = h[h.length - 1];
  if (!last || last.price <= 0 || older.length === 0) return null;
  const base = older[older.length - 1].price;
  if (!base || base <= 0) return null;
  return ((last.price - base) / base) * 100;
}

// ================== OB SLOPE (FASE 1) ==================
export function calcObSlope(samples) {
  if (!Array.isArray(samples) || samples.length < SETTINGS.entry.obSlopeMinSamples) return null;
  const s = samples
    .map((x) => ({
      ts: Number(x?.ts || 0),
      score: Number(x?.score ?? x?.obScore ?? x?.avgScore ?? 0),
    }))
    .filter((x) => x.ts > 0 && Number.isFinite(x.score))
    .sort((a, b) => a.ts - b.ts);

  if (s.length < SETTINGS.entry.obSlopeMinSamples) return null;

  const first = s[0].score;
  const last = s[s.length - 1].score;
  const n = s.length - 1;
  if (n <= 0) return null;
  return (last - first) / n;
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
  const h = normalizePriceHist(priceHist);
  if (h.length < 2) return true;
  const prices = h.map((x) => x.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
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

// ENTRY gate based on OB result + spread/lor + thresholds + slope + hard gates
export function passEntryFromObPlus({
  obView,
  mode,
  consistencyRatio,
  confidence,
  obSlope,
}) {
  const base = passEntryFromOb(obView, mode);
  if (!base.ok) return base;

  if (Number(confidence || 0) < SETTINGS.entry.minConfidence) {
    return { ok: false, why: `Confidence < ${SETTINGS.entry.minConfidence}` };
  }
  if (Number(consistencyRatio || 0) < SETTINGS.entry.entryConsistencyMin) {
    return { ok: false, why: `Consistency < ${(SETTINGS.entry.entryConsistencyMin * 100).toFixed(0)}%` };
  }

  if (SETTINGS.entry.obSlopeEnabled && Number.isFinite(obSlope)) {
    if (mode === "bull" && obSlope < SETTINGS.entry.obSlopeMinBull) {
      return { ok: false, why: "OB slope down" };
    }
    if (mode === "bear" && obSlope > SETTINGS.entry.obSlopeMaxBear) {
      return { ok: false, why: "OB slope up" };
    }
  }

  return { ok: true, why: "ENTRY gates passed" };
}

export function passEntryFromOb(ob, mode) {
  if (!ob || !ob.valid) return { ok: false, why: "OB validating" };
  if (ob.stale) return { ok: false, why: "OB stale" };

  const score = Number(ob.score ?? ob.avgScore ?? 0);
  const spreadPct = Number(ob.spreadPct ?? 999);
  const lor = Number(ob.lor ?? 1);

  // ✅ NIEUW: liquiditeitsvloer (min bid/ask depth binnen 1%)
  const depthMinUsd1p = Number(ob.depthMinUsd1p ?? 0);
  if (depthMinUsd1p < SETTINGS.entry.minDepthUsd1p) {
    return { ok: false, why: `Depth too thin (<$${SETTINGS.entry.minDepthUsd1p})` };
  }

  if (lor > SETTINGS.entry.largestOrderRatioMax) return { ok: false, why: "OB suspicious (largest order)" };
  if (spreadPct > SETTINGS.entry.spreadMaxPct) return { ok: false, why: "Spread too wide" };

  if (mode === "bull") {
    if (score < SETTINGS.entry.obScoreMin) return { ok: false, why: "OB score too low" };
  } else {
    if (score > -SETTINGS.entry.obScoreMin) return { ok: false, why: "OB score too low" };
  }

  return { ok: true, why: "OB gate passed" };
}

export function nextDesiredStage(c, mode, priceHist, consistencyOk, btcRange24, entryOk) {
  if (!passRadar(c, btcRange24)) return "OUT";
  if (entryOk) return "ENTRY";
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
export function computeConfidence({ obScore, obAgree, vm, volAcc, btc }) {
  const obStrength = clamp01(mapLinear(Math.abs(obScore), 0.04, 0.20));
  const obBonus = obAgree === 3 ? 1.0 : obAgree === 2 ? 0.85 : 0.6;
  const ob = obStrength * obBonus;

  const vmStrength = clamp01(mapLinear(vm, SETTINGS.buildup.vmMin, 0.40));
  const vaStrength = clamp01(mapLinear(volAcc, 1.0, 1.25));
  const btcStrength = clamp01(mapLinear(Math.abs(btc?.chg24 || 0), SETTINGS.btcChgGate, 2.5));

  const score = 40 * ob + 20 * vmStrength + 20 * vaStrength + 20 * btcStrength;
  return Math.round(clamp(score, 0, 100));
}

export function computeAtrPctFromPriceHist(priceHist) {
  const h = normalizePriceHist(priceHist);
  if (h.length < 3) return 0.01;

  let sum = 0;
  let n = 0;
  for (let i = 1; i < h.length; i++) {
    const a = Number(h[i - 1]?.price || 0);
    const b = Number(h[i]?.price || 0);
    if (a > 0 && b > 0) {
      sum += Math.abs(b - a) / a;
      n++;
    }
  }
  const avg = n ? sum / n : 0.01;
  return clamp(avg, 0.002, 0.12);
}

export function computeSLTP({ mode, price, atrPct }) {
  const atr = price * atrPct;
  const slDist = 1.8 * atr;
  const tpDist = 3.0 * atr;

  if (mode === "bull") return { sl: price - slDist, tp: price + tpDist };
  return { sl: price + slDist, tp: price - tpDist };
}

// ================== HELPERS ==================
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function clamp01(n) { return clamp(n, 0, 1); }
function mapLinear(x, a, b) {
  if (b === a) return 0;
  return (Number(x || 0) - a) / (b - a);
}
function num(n) { return (Number(n) || 0).toFixed(2); }
function sign(n) { return `${n >= 0 ? "+" : ""}${num(n)}`; }
function short(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}