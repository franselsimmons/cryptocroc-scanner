import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ================== SECRETS / AUTH ==================
export function requireSecret(req, res) {
  const authHeader = String(req.headers?.authorization || "");
  const bearer =
    authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";

  const token =
    String(req.query?.token || "") ||
    bearer ||
    String(req.headers?.["x-cron-secret"] || "") ||
    String(req.headers?.["x-token"] || "");

  const secret = String(process.env.CRON_SECRET || "");
  if (!secret) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "Missing CRON_SECRET env var" }));
    return false;
  }

  if (!token || token !== secret) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: false,
        error: "Unauthorized",
        hint: "Expected token query param, Bearer authorization header, x-cron-secret, or x-token",
      })
    );
    return false;
  }

  return true;
}

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return String(v);
}

// ================== FETCH MET TIMEOUT ==================
export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ================== HELPER VOOR VEILIGE WEBHOOK URL ==================
function safeWebhookUrl(value) {
  const s = String(value || "").trim();
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? s : "";
  } catch {
    return "";
  }
}

// ================== DISCORD ==================
export async function sendDiscord(webhookUrl, content) {
  const url = safeWebhookUrl(webhookUrl);
  if (!url) return { ok: false, skip: true, reason: "invalid webhook URL" };

  const max = 1800;
  let text = String(content || "");
  const chunks = [];

  while (text.length > max) {
    chunks.push(text.slice(0, max));
    text = text.slice(max);
  }
  if (text) chunks.push(text);

  try {
    for (const chunk of chunks) {
      const r = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: chunk }),
        },
        8000
      );

      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return { ok: false, status: r.status, error: body.slice(0, 200) };
      }
    }

    return { ok: true, count: chunks.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function webhookForMoonStage(stage) {
  const s = String(stage || "").toUpperCase();
  if (s === "BUILDUP") return safeWebhookUrl(process.env.DISCORD_WEBHOOK_BUILDUP_MOON);
  if (s === "ALMOST") return safeWebhookUrl(process.env.DISCORD_WEBHOOK_ALMOST_MOON);
  if (s === "ELITE") return safeWebhookUrl(process.env.DISCORD_WEBHOOK_ELITE_MOON);
  return "";
}

export function webhookMoonPortfolio() {
  return (
    safeWebhookUrl(process.env.DISCORD_WEBHOOK_PORTFOLIO_MOON) ||
    safeWebhookUrl(process.env.DISCORD_WEBHOOK_ELITE_MOON)
  );
}

export function fmtModeLabel(mode) {
  return mode === "bear" ? "SHORT" : "LONG";
}

export function fmtTs(ts) {
  const d = new Date(Number(ts || 0) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${da} ${h}:${mi}`;
}

export function durMinutes(a, b) {
  const A = Number(a || 0);
  const B = Number(b || 0);
  if (!(A > 0 && B > 0 && B >= A)) return 0;
  return Math.round((B - A) / 60000);
}

export function fmtMoonLine(item, mode, extra = "", tsNow = Date.now()) {
  const side = fmtModeLabel(mode);
  const sym = String(item?.symbol || "");
  const stage = String(item?.stage || "");
  const px = Number(item?.price || 0);
  const ch = Number(item?.change24 || 0);
  const vm = Number(item?.vm || 0);
  const conf = Number(item?.confidence || 0);

  const ob = item?.ob || {};
  const obScore = Number(ob?.score ?? 0);
  const spread = Number(ob?.spreadPct ?? 0);

  const line1 = `**${sym}** → **${stage}** (MOON ${side})`;
  const line2 = `t: ${fmtTs(tsNow)} | $${px.toFixed(8)} | 24h: ${ch >= 0 ? "+" : ""}${ch.toFixed(2)}% | VM: ${vm.toFixed(3)} | conf: ${conf}`;
  const line3 = `OB: score ${obScore.toFixed(4)} | spread ${spread.toFixed(3)}%`;
  const line4 = extra ? `\n${extra}` : "";
  return `${line1}\n${line2}\n${line3}${line4}`;
}

// ================== KEYS ==================
const NS = "cc:moon";

export const keyMoonLatest = (mode) => `${NS}:latest:${mode}`;
export const keyMoonState = (mode) => `${NS}:state:${mode}`;
export const keyMoonReset = (mode) => `${NS}:reset:${mode}`;
export const keyMoonPortfolio = (mode) => `${NS}:portfolio:${mode}`;
export const keyMoonPositions = (mode) => `${NS}:positions:${mode}`;
export const keyMoonObSamples = (mode, symbol) => `${NS}:ob:samples:${mode}:${String(symbol).toUpperCase()}`;
export const keyMoonObResult = (mode, symbol) => `${NS}:ob:result:${mode}:${String(symbol).toUpperCase()}`;
export const keyMoonDiagList = (mode) => `${NS}:diag:list:${mode}`;
export const keyMoonDiagSnap = (mode) => `${NS}:diag:snap:${mode}`;

export const keyMoonScanLock = (mode) => `${NS}:scan_lock:${mode}`;
export const keyMoonCooldown = (mode, symbol) =>
  `${NS}:cooldown:${mode}:${String(symbol).toUpperCase()}`;

// ================== CONFIG ==================
export const MOON = {
  CG_PER_PAGE: 250,
  CG_START_PAGE: 1,
  CG_PAGES: 3,
  RADAR_LIMIT: 180,

  btcChgGateBull: 1.0,
  btcChgGateBear: -1.0,
  btcStrongBull: 2.2,
  btcStrongBear: -2.2,
  btcRangeMin: 0.8,
  btcRangeMaxBull: 10.5,
  btcRangeMaxBear: 12.0,

  mcapMin: 1_500_000,
  mcapMax: 800_000_000,

  radar: {
    minVol24h: 450_000,
    minVm: 0.045,
    maxRange24: 38,
    dir1hMinBull: -0.4,
    dir24MinBull: 1.2,
    dir1hMaxBear: 0.4,
    dir24MaxBear: -1.2,
  },

  buildup: {
    minVolAcc: 1.06,
    minConfidence: 46,
  },

  almost: {
    minConfidence: 58,
    maxFlat60Pct: 6.5,
  },

  elite: {
    minConfidence: 72,
    consistencyMin: 0.60,
    obScoreMin: 0.045,
    spreadMaxPct: 0.75,
    largestOrderRatioMax: 0.72,
    samplesNeed: 2,
    samplesWindowSec: 2100,
    minAgree: 1,
    depthK: 0.0014,
    depthMinUsd: 3_000,
    depthMaxUsd: 600_000,
    range24Max: 28,
    obSlopeEnabled: true,
    obSlopeMinBull: 0.002,
    obSlopeMaxBear: -0.002,
    roll: {
      maxDeltaPrice15mPct: 3.6,
      minDeltaVol15m: 0.8,
      needCompression: false,
      minObSlope: 0.002,
      maxObStability: 0.18,
    },
  },

  obSampler: {
    spreadMaxPct: 1.15,
    largestOrderRatioMax: 0.78,
  },

  tiers: [
    {
      name: "small",
      maxMc: 40_000_000,
      minConfidence: 68,
      spreadMaxPct: 0.95,
      depthMinUsd: 3_000,
      obScoreMin: 0.040,
      range24Max: 30,
      needCompression: false,
      maxObStability: 0.18,
    },
    {
      name: "mid",
      maxMc: 180_000_000,
      minConfidence: 72,
      spreadMaxPct: 0.70,
      depthMinUsd: 12_000,
      obScoreMin: 0.050,
      range24Max: 26,
      needCompression: false,
      maxObStability: 0.14,
    },
    {
      name: "upper-mid",
      maxMc: 800_000_000,
      minConfidence: 76,
      spreadMaxPct: 0.45,
      depthMinUsd: 40_000,
      obScoreMin: 0.060,
      range24Max: 22,
      needCompression: false,
      maxObStability: 0.10,
    },
  ],

  portfolio: {
    posUsd: 50,
    maxOpen: 4,
    closeOnBtcFlip: true,
  },
};

export function getTierForMcap(mcap) {
  const mc = Number(mcap) || 0;
  for (const tier of MOON.tiers) {
    if (mc <= tier.maxMc) return tier;
  }
  return MOON.tiers[MOON.tiers.length - 1];
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function clamp(x, a, b) {
  return Math.max(a, Math.min(b, x));
}

// ================== FILTERS / EXCLUSIONS ==================
const EXACT_SYMBOL_BLOCKLIST = new Set([
  "USDT", "USDC", "FDUSD", "TUSD", "DAI", "USDE", "USDS", "FRXUSD", "USDQ",
  "USDR", "USDH", "USDCV", "USDON", "GHO", "AUSD", "EURC", "EURQ", "EURCV",
  "EURI", "CRVUSD", "FIDD", "CASH", "XUSD", "XUSDC", "XUSDT", "MUSD",
  "QQQON", "COINON", "CRCLON", "AMZNX", "AAPLX", "METAX", "NVDAX", "TSLAX",
  "GOOGLX", "HOODX", "COINX", "CRCLX"
]);

const NAME_BLOCK_PATTERNS = [
  "stable",
  "usd",
  "dollar",
  "coinvertible",
  "tokenized stock",
  "xstock",
  "etf",
  "treasury",
  "money market",
];

export function isBlockedMoonAsset(c) {
  const sym = String(c?.symbol || "").toUpperCase().trim();
  const name = String(c?.name || "").toLowerCase().trim();

  if (!sym) return true;
  if (EXACT_SYMBOL_BLOCKLIST.has(sym)) return true;

  for (const p of NAME_BLOCK_PATTERNS) {
    if (name.includes(p)) return true;
  }

  const price = n(c?.price, 0);
  const change24 = Math.abs(n(c?.change24, 0));
  const vm = n(c?.vm, 0);

  if (price > 0.94 && price < 1.06 && change24 < 1.5 && vm > 0.8) return true;

  return false;
}

export async function tryAcquireMoonScanLock(mode, ttlSec = 90) {
  const key = keyMoonScanLock(mode);
  const now = Date.now();
  const ok = await kv.set(key, { ts: now }, { nx: true, ex: ttlSec });
  return { ok: !!ok, key, ts: now };
}

export async function setMoonCooldown(mode, symbol, minutes = 90) {
  const key = keyMoonCooldown(mode, symbol);
  await kv.set(key, { ts: Date.now() }, { ex: minutes * 60 });
}

export async function hasMoonCooldown(mode, symbol) {
  const v = await kv.get(keyMoonCooldown(mode, symbol));
  return !!v;
}

// ================== BTC – UIT UNIVERSE ==================
const KEY_UNIVERSE_LATEST = "universe:latest";

export async function fetchBTCGateFromUniverse() {
  const uni = await kv.get(KEY_UNIVERSE_LATEST);
  const btc = uni?.btc || null;

  if (!btc || typeof btc !== "object") {
    return { ts: Date.now(), state: "NEUTRAL", chg24: 0, range24: 0, chg1h: 0 };
  }

  const chg24 = Number(btc?.chg24 || 0);
  const chg1h = Number(btc?.chg1h || 0);
  const range24 = Number(btc?.range24 || 0);

  let state = "NEUTRAL";
  if (chg24 >= MOON.btcChgGateBull) state = "BULL";
  else if (chg24 <= MOON.btcChgGateBear) state = "BEAR";

  return {
    ts: Number(uni?.ts || Date.now()),
    state,
    chg24: +chg24.toFixed(3),
    chg1h: +chg1h.toFixed(3),
    range24: +range24.toFixed(3),
  };
}

const KEY_BTC = "cc:btc:gate";

export async function fetchBTCGateCached() {
  const cached = await kv.get(KEY_BTC);
  const now = Date.now();
  if (cached?.ts && now - cached.ts < 60_000) return cached;

  const prev = cached && typeof cached === "object" ? cached : null;

  const url =
    "https://api.coingecko.com/api/v3/coins/markets?" +
    new URLSearchParams({
      vs_currency: "usd",
      ids: "bitcoin",
      order: "market_cap_desc",
      per_page: "1",
      page: "1",
      sparkline: "false",
      price_change_percentage: "24h,1h",
    });

  let r;
  try {
    r = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 8000);
  } catch {
    if (prev) return prev;
    const fallback = { ts: now, state: "NEUTRAL", chg24: 0, chg1h: 0, range24: 0 };
    await kv.set(KEY_BTC, fallback, { ex: 70 });
    return fallback;
  }

  const j = await r.json().catch(() => null);
  const row = Array.isArray(j) ? j[0] : null;

  if (!row) {
    if (prev) return prev;
    const fallback = { ts: now, state: "NEUTRAL", chg24: 0, chg1h: 0, range24: 0 };
    await kv.set(KEY_BTC, fallback, { ex: 70 });
    return fallback;
  }

  const chg24 = n(row?.price_change_percentage_24h, 0);
  const chg1h = n(row?.price_change_percentage_1h_in_currency, 0);
  const high = n(row?.high_24h, 0);
  const low = n(row?.low_24h, 0);
  const range24 = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 0;

  let state = "NEUTRAL";
  if (chg24 >= MOON.btcChgGateBull) state = "BULL";
  else if (chg24 <= MOON.btcChgGateBear) state = "BEAR";

  const out = {
    ts: now,
    state,
    chg24: +chg24.toFixed(3),
    chg1h: +chg1h.toFixed(3),
    range24: +range24.toFixed(3),
  };

  await kv.set(KEY_BTC, out, { ex: 70 });
  return out;
}

export function isModeAllowedByBtc(mode, btcState) {
  const s = String(btcState || "NEUTRAL").toUpperCase();
  if (s === "NEUTRAL") return true;
  if (mode === "bull") return s === "BULL";
  return s === "BEAR";
}

// ================== COINGECKO CACHE ==================
const KEY_CG = "cc:cg:top";

export async function fetchCoinGeckoTopCached() {
  const cached = await kv.get(KEY_CG);
  const now = Date.now();
  if (cached?.ts && now - cached.ts < 120_000 && Array.isArray(cached?.list)) return cached.list;

  const allMap = new Map();

  for (let p = MOON.CG_START_PAGE; p < MOON.CG_START_PAGE + MOON.CG_PAGES; p++) {
    const urlVol =
      "https://api.coingecko.com/api/v3/coins/markets?" +
      new URLSearchParams({
        vs_currency: "usd",
        order: "volume_desc",
        per_page: String(MOON.CG_PER_PAGE),
        page: String(p),
        sparkline: "false",
        price_change_percentage: "1h,24h",
      });

    let r;
    try {
      r = await fetchWithTimeout(urlVol, { headers: { accept: "application/json" } }, 8000);
    } catch {
      continue;
    }
    if (!r.ok) continue;

    const j = await r.json().catch(() => []);
    if (Array.isArray(j)) {
      for (const row of j) {
        const id = String(row?.id || "");
        if (!id) continue;
        if (!allMap.has(id)) allMap.set(id, row);
      }
    }
  }

  const all = [];
  for (const row of allMap.values()) {
    const price = n(row?.current_price, 0);
    const volume = n(row?.total_volume, 0);
    const marketCap = n(row?.market_cap, 0);
    const high = n(row?.high_24h, 0);
    const low = n(row?.low_24h, 0);
    const range24 = high > 0 && low > 0 ? ((high - low) / ((high + low) / 2)) * 100 : 0;

    const item = {
      id: String(row?.id || ""),
      symbol: String(row?.symbol || "").toUpperCase(),
      name: String(row?.name || ""),
      image: String(row?.image || ""),
      price,
      volume,
      marketCap,
      change24: n(row?.price_change_percentage_24h, 0),
      change1h: n(row?.price_change_percentage_1h_in_currency, 0),
      range24,
      vm: marketCap > 0 ? volume / marketCap : 0,
    };

    if (!isBlockedMoonAsset(item)) {
      all.push(item);
    }
  }

  if (!all.length && cached?.list?.length) {
    return cached.list;
  }

  await kv.set(KEY_CG, { ts: now, list: all }, { ex: 130 });
  return all;
}

// ================== BITGET SYMBOL CACHE ==================
const KEY_BG = "cc:bitget:spot:usdt:symbols";

export async function getBitgetSpotUsdtSymbols() {
  const cached = await kv.get(KEY_BG);
  const now = Date.now();
  if (cached?.ts && now - cached.ts < 10 * 60_000 && Array.isArray(cached?.symbols)) {
    return new Set(cached.symbols);
  }

  const url = "https://api.bitget.com/api/v2/spot/public/symbols";

  let r;
  try {
    r = await fetchWithTimeout(url, { headers: { accept: "application/json" } }, 8000);
  } catch {
    return new Set();
  }

  const j = await r.json().catch(() => null);
  if (!r.ok || String(j?.code || "") !== "00000") {
    return new Set();
  }

  const set = new Set();
  for (const row of j?.data || []) {
    const status = String(row?.status || "").toLowerCase();
    const quote = String(row?.quoteCoin || "");
    const base = String(row?.baseCoin || "");
    if (status !== "online") continue;
    if (quote !== "USDT") continue;
    if (!base) continue;
    set.add(base.toUpperCase());
  }

  await kv.set(KEY_BG, { ts: now, symbols: Array.from(set) }, { ex: 12 * 60 });
  return set;
}

// ================== HISTORY HELPERS ==================
export function updatePriceHist(prev, price) {
  const arr = Array.isArray(prev) ? [...prev] : [];
  const p = n(price, 0);
  if (p > 0) arr.push(p);
  return arr.slice(-120);
}

export function updateVolHist(prev, vol) {
  const arr = Array.isArray(prev) ? [...prev] : [];
  const v = n(vol, 0);
  if (v >= 0) arr.push(v);
  return arr.slice(-120);
}

export function volAccFromHist(volHist) {
  const a = Array.isArray(volHist) ? volHist : [];
  if (a.length < 2) return 1;
  const first = n(a[0], 0);
  const last = n(a[a.length - 1], 0);
  if (!(first > 0 && last > 0)) return 1;
  return clamp(last / first, 0, 50);
}

export function priceFlatPct(priceHist, lastN = 60) {
  const a = Array.isArray(priceHist) ? priceHist : [];
  const slice = a.slice(-Math.max(2, lastN));
  if (slice.length < 2) return 0;
  const min = Math.min(...slice);
  const max = Math.max(...slice);
  const mid = (min + max) / 2;
  if (!(mid > 0)) return 0;
  return ((max - min) / mid) * 100;
}

// ================== DEPTH / CONFIDENCE ==================
export function depthFloorUsd(mcap, tier = null) {
  const mc = n(mcap, 0);
  if (!tier) tier = getTierForMcap(mc);
  const k = MOON.elite.depthK;
  const floor = mc * k;
  const min = tier.depthMinUsd || MOON.elite.depthMinUsd;
  const max = MOON.elite.depthMaxUsd;
  return clamp(floor, min, max);
}

export function computeConfidence({ obScore, obAgree, vm, volAcc, btc, change24 = 0, range24 = 0 }) {
  const vmN = clamp(n(vm, 0), 0, 5);
  const volN = clamp(n(volAcc, 1), 0, 8);
  const obN = clamp(Math.abs(n(obScore, 0)) * 10, 0, 3.0);
  const agreeN = clamp(n(obAgree, 0), 0, 6);
  const chN = clamp(Math.abs(n(change24, 0)) / 12, 0, 2);
  const rangePenalty = clamp(Math.max(0, n(range24, 0) - 24) / 10, 0, 2.4);

  const btcCh = Math.abs(n(btc?.chg24, 0));
  const btcN = clamp(btcCh / 3, 0, 1);

  const score =
    18 +
    vmN * 10 +
    volN * 7 +
    obN * 16 +
    agreeN * 6 +
    chN * 8 -
    rangePenalty * 8 -
    btcN * 2;

  return clamp(Math.round(score), 0, 100);
}

// ================== GATES ==================
export function passRadarMoon(c, mode, btc = null) {
  const mc = n(c?.marketCap, 0);
  const vol = n(c?.volume, 0);
  const vm = n(c?.vm, 0);
  const range24 = n(c?.range24, 0);

  if (isBlockedMoonAsset(c)) return false;
  if (!(mc >= MOON.mcapMin && mc <= MOON.mcapMax)) return false;
  if (vol < MOON.radar.minVol24h) return false;
  if (vm < MOON.radar.minVm) return false;
  if (range24 > MOON.radar.maxRange24) return false;

  const ch24 = n(c?.change24, 0);
  const ch1h = n(c?.change1h, 0);

  if (mode === "bull") {
    if (ch24 < MOON.radar.dir24MinBull) return false;
    if (ch1h < MOON.radar.dir1hMinBull) return false;
    if (n(btc?.chg24, 0) >= MOON.btcStrongBull && ch24 < 2.2) return false;
  } else {
    if (ch24 > MOON.radar.dir24MaxBear) return false;
    if (ch1h > MOON.radar.dir1hMaxBear) return false;
    if (n(btc?.chg24, 0) <= MOON.btcStrongBear && ch24 > -2.2) return false;
  }

  return true;
}

export function passBuildupMoon({ c, volAcc, confidence }) {
  const acc = n(volAcc, 1);
  if (acc < MOON.buildup.minVolAcc) return { ok: false, why: "Vol acc too low" };
  if (n(confidence, 0) < MOON.buildup.minConfidence) return { ok: false, why: "Confidence low" };
  return { ok: true, why: "OK" };
}

export function passAlmostMoon({ priceHist, volAcc, confidence, consistencyRatio, c }) {
  if (n(confidence, 0) < MOON.almost.minConfidence) return { ok: false, why: "Confidence low" };
  if (priceFlatPct(priceHist, 60) > MOON.almost.maxFlat60Pct) return { ok: false, why: "Too flat" };
  if (n(volAcc, 1) < MOON.buildup.minVolAcc) return { ok: false, why: "Vol acc too low" };
  if (n(consistencyRatio, 0) < 0.58) return { ok: false, why: "Consistency fail" };
  if (n(c?.range24, 0) > 30) return { ok: false, why: "Range too high" };
  return { ok: true, why: "OK" };
}

export function passEliteMoon({ mode, obView, confidence, consistencyRatio, depthUsd, floorUsd, range24, tier }) {
  const minConf = tier?.minConfidence ?? MOON.elite.minConfidence;
  const consistencyMin = MOON.elite.consistencyMin;
  const rangeMax = tier?.range24Max ?? MOON.elite.range24Max;
  const obScoreMin = tier?.obScoreMin ?? MOON.elite.obScoreMin;
  const spreadMax = tier?.spreadMaxPct ?? MOON.elite.spreadMaxPct;
  const lorMax = MOON.elite.largestOrderRatioMax;

  if (n(confidence, 0) < minConf) return { ok: false, why: "Confidence low" };
  if (n(consistencyRatio, 0) < consistencyMin) return { ok: false, why: "Consistency low" };
  if (n(range24, 0) > rangeMax) return { ok: false, why: "Range24 too high" };

  if (!obView || obView.status === "none") return { ok: false, why: "No OB" };
  if (!obView.valid) return { ok: false, why: `OB invalid: ${String(obView.reason || "bad")}` };

  const score = n(obView.score, 0);
  if (mode === "bull") {
    if (score < obScoreMin) return { ok: false, why: "OB score low" };
  } else {
    if (score > -obScoreMin) return { ok: false, why: "OB score low" };
  }

  if (n(obView.spreadPct, 999) > spreadMax) return { ok: false, why: "Spread too wide" };
  if (n(obView.lor, 0) > lorMax) return { ok: false, why: "Largest order suspicious" };
  if (n(depthUsd, 0) < n(floorUsd, 0)) return { ok: false, why: "Depth too thin" };

  return { ok: true, why: "OK" };
}

// ================== RISK ==================
export function computeMoonRisk({ mode, price, range24, confidence, depthOk, tier }) {
  const px = n(price, 0);
  if (!(px > 0)) return null;

  const r = clamp(n(range24, 5), 1.5, 26);
  const conf = clamp(n(confidence, 50), 0, 100);
  const confK = clamp(conf / 100, 0.18, 1);

  let slBase = 0.26;
  let tpBase = 0.62;

  if (tier?.name === "small") {
    slBase = 0.30;
    tpBase = 0.70;
  } else if (tier?.name === "mid") {
    slBase = 0.26;
    tpBase = 0.64;
  } else if (tier?.name === "upper-mid") {
    slBase = 0.22;
    tpBase = 0.58;
  }

  const slMul = clamp(slBase + (1 - confK) * 0.08, 0.20, 0.40);
  const tpMul = clamp(tpBase + confK * 0.18, 0.52, 0.86);

  const safe = depthOk ? 1 : 0.92;

  const slPct = (r * slMul) * safe;
  const tpPct = (r * tpMul) * safe;

  let sl = 0;
  let tp3 = 0;

  if (mode === "bull") {
    sl = px * (1 - slPct / 100);
    tp3 = px * (1 + tpPct / 100);
  } else {
    sl = px * (1 + slPct / 100);
    tp3 = px * (1 - tpPct / 100);
  }

  return {
    sl: +sl.toFixed(8),
    tp3: +tp3.toFixed(8),
    slPct: +slPct.toFixed(2),
    tpPct: +tpPct.toFixed(2),
  };
}

export function calcPnlPct({ mode, entryPrice, priceNow }) {
  const e = n(entryPrice, 0);
  const p = n(priceNow, 0);
  if (!(e > 0 && p > 0)) return 0;
  if (mode === "bull") return ((p - e) / e) * 100;
  return ((e - p) / e) * 100;
}

export function hitStopOrTp({ mode, priceNow, sl, tp3 }) {
  const p = n(priceNow, 0);
  const SL = n(sl, 0);
  const TP = n(tp3, 0);

  if (!(p > 0 && SL > 0 && TP > 0)) return { hit: false, kind: null };

  if (mode === "bull") {
    if (p <= SL) return { hit: true, kind: "SL" };
    if (p >= TP) return { hit: true, kind: "TP" };
  } else {
    if (p >= SL) return { hit: true, kind: "SL" };
    if (p <= TP) return { hit: true, kind: "TP" };
  }

  return { hit: false, kind: null };
}

// ================== DIAG ==================
export async function saveMoonDiag(mode, diag) {
  try {
    const m = mode === "bear" ? "bear" : "bull";
    const payload = typeof diag === "object" ? diag : { ts: Date.now(), mode: m, note: "bad diag" };

    await kv.set(keyMoonDiagSnap(m), payload);

    const listKey = keyMoonDiagList(m);
    const max = 50;

    if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
      await kv.lpush(listKey, JSON.stringify(payload));
      await kv.ltrim(listKey, 0, max - 1);
    }
  } catch {}
}