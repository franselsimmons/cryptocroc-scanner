// /api/_core.js
import { kv } from "@vercel/kv";

export const RUNTIME_CONFIG = { runtime: "nodejs" };

// ====== CONFIG ======
export const CFG = {
  obStaleSec: 180, // orderbook sample ouder dan 3 min = stale
  consistencyWindowMs: 2 * 60 * 60 * 1000, // 2 uur
};

export const SETTINGS = {
  // Universe / limits
  CG_TOP: 250,
  RADAR_LIMIT: 160,

  // Poolfilters (RADAR)
  mcapMin: 5_000_000,
  mcapMax: 400_000_000,
  volMinRadar: 500_000,
  vmMinRadar: 0.15,
  maxAbsChg24: 35,

  // BTC gate basis (blijft simpel & voorspelbaar)
  btcChgGate: 0.8,
  btcRangeMin: 2,
  btcRangeMaxBull: 10,
  btcRangeMaxBear: 10,

  // Stage eisen
  buildup: { chgMin: 1.2, vmMin: 0.22, volMin: 1_200_000 },
  almost: { vmMin: 0.26, volMin: 2_000_000, priceFlatMax: 6.5 },

  // ENTRY/ELITE eisen
  elite: {
    minConsistencyRatio: 0.67,
    minConsistencySamples: 6,
    obMinScore: 60,
    obMaxSpreadPct: 0.35,
  },

  // “Geen overslaan” rule
  minScansPerStage: 2,
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
    // discord mag nooit je scan slopen
  }
}

export function webhookForStage(stage) {
  if (stage === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;
  if (stage === "BUILDUP") return process.env.DISCORD_WEBHOOK_BUILDUP;
  if (stage === "ALMOST") return process.env.DISCORD_WEBHOOK_ALMOST;
  if (stage === "ELITE") return process.env.DISCORD_WEBHOOK_ELITE; // ENTRY kanaal
  return null;
}

export function fmtCoinLine(c, mode, stage, extra = {}) {
  const base = "https://cryptocroc-scanner-omega.vercel.app";
  const page = `${base}/?mode=${encodeURIComponent(mode)}&symbol=${encodeURIComponent(
    c.symbol
  )}`;

  const bits = [
    `**${c.symbol}** → **${stage === "ELITE" ? "ENTRY" : stage}** (${mode.toUpperCase()})`,
    `prijs: $${num(c.price)} | chg24: ${sign(c.change24)}% | range24: ${num(c.range24)}%`,
    `vol: $${short(c.volume)} | mc: $${short(c.marketCap)} | vm: ${num(c.vm)}`,
  ];

  if (extra?.consistency) {
    bits.push(
      `consistency: ${(extra.consistency.ratio * 100).toFixed(0)}% (${extra.consistency.same}/${extra.consistency.total})`
    );
  }
  if (extra?.ob) {
    bits.push(
      `OB: ${extra.ob.valid ? "valid" : "invalid"} | score: ${extra.ob.avgScore ?? "?"} | spread: ${num(
        extra.ob.spreadPct
      )}%`
    );
  }
  if (extra?.risk) {
    bits.push(`SL: $${num(extra.risk.sl)} | TP1: $${num(extra.risk.tp1)} | TP2: $${num(extra.risk.tp2)}`);
  }

  bits.push(`open: ${page}`);
  return bits.join("\n");
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
export const keyState = (mode) => `state:${mode}`;
export const keyReset = (mode) => `resetAt:${mode}`;
export const keyBitgetSymbols = "bitget:symbols:spotusdt";

// ====== BTC VOL KNOP (geen pseudo-ATR, alleen range24) ======
export function coinRangeCapFromBtcRange(btcRange24) {
  // range cap = 30% + (btcRange24-5)*2, clamp 25..40
  const raw = 30 + (Number(btcRange24 || 0) - 5) * 2;
  return clamp(raw, 25, 40);
}

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
  const low = Number(x.low_24h || 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  // BTC gate (simpel)
  const inVolWindow = range24 >= SETTINGS.btcRangeMin && range24 <= SETTINGS.btcRangeMaxBull; // zelfde cap bull/bear
  const bull = inVolWindow && chg24 >= SETTINGS.btcChgGate;
  const bear = inVolWindow && chg24 <= -SETTINGS.btcChgGate;

  let state = "NEUTRAL";
  if (bull) state = "BULL";
  else if (bear) state = "BEAR";

  return { state, chg24, range24 };
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

// ====== FILTERS ======
export function passRadar(c, coinRangeCap) {
  if (c.marketCap < SETTINGS.mcapMin) return false;
  if (c.marketCap > SETTINGS.mcapMax) return false;
  if (c.volume < SETTINGS.volMinRadar) return false;
  if (c.vm < SETTINGS.vmMinRadar) return false;
  if (Math.abs(c.change24) > SETTINGS.maxAbsChg24) return false;
  if (c.range24 > coinRangeCap) return false;
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
  const minP = Math.min(...priceHist);
  const maxP = Math.max(...priceHist);
  if (minP <= 0) return true;
  const pct = ((maxP - minP) / minP) * 100;
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
export function stageRank(stage) {
  if (stage === "RADAR") return 1;
  if (stage === "BUILDUP") return 2;
  if (stage === "ALMOST") return 3;
  if (stage === "ELITE") return 4; // ENTRY
  return 0;
}

export function computeRisk(c, mode) {
  // simpele, stabiele risk (kan later ATR/OB-based)
  // basePct = clamp(range24/200, 0.015..0.035)
  const basePct = clamp((Number(c.range24 || 0) / 200) || 0.02, 0.015, 0.035);

  if (mode === "bull") {
    const sl = c.price * (1 - basePct);
    const tp1 = c.price * (1 + basePct * 2);
    const tp2 = c.price * (1 + basePct * 4);
    return { sl, tp1, tp2 };
  } else {
    const sl = c.price * (1 + basePct);
    const tp1 = c.price * (1 - basePct * 2);
    const tp2 = c.price * (1 - basePct * 4);
    return { sl, tp1, tp2 };
  }
}

// ====== SPIKE GUARD (median fallback) ======
export function median3(a, b, c) {
  const arr = [a, b, c].map((x) => Number(x || 0)).sort((x, y) => x - y);
  return arr[1];
}

export function guardWithMedian(history, nextVal, maxJumpRatio = 1.0) {
  // history: laatste 2 waarden (of minder). Als we 2 hebben: median( v1, v2, next )
  const n = Number(nextVal || 0);
  if (!Array.isArray(history)) return n;

  const h = history.slice(-2).map((x) => Number(x || 0));
  if (h.length < 2) return n;

  const med = median3(h[0], h[1], n);
  // spike detect: als next meer dan (1+maxJumpRatio) * median afwijkt -> median pakken
  const denom = Math.max(1e-9, Math.abs(med));
  const diffRatio = Math.abs(n - med) / denom;
  if (diffRatio > maxJumpRatio) return med;
  return n;
}

// ====== CONSISTENCY WINDOW ======
export function updateConsistency(dirHist, dir, now) {
  const hist = Array.isArray(dirHist) ? dirHist.slice(-64) : [];
  hist.push({ ts: now, dir });

  // prune > 2h
  const cut = now - CFG.consistencyWindowMs;
  const pruned = hist.filter((x) => Number(x.ts || 0) >= cut);

  const total = pruned.length;
  const same = pruned.filter((x) => x.dir === dir).length;
  const ratio = total > 0 ? same / total : 0;

  const pass =
    total >= SETTINGS.elite.minConsistencySamples &&
    ratio >= SETTINGS.elite.minConsistencyRatio;

  return { hist: pruned, total, same, ratio, pass };
}

// helpers
export function clamp(x, a, b) {
  x = Number(x || 0);
  return Math.max(a, Math.min(b, x));
}
function num(n) {
  return (Number(n) || 0).toFixed(2);
}
function sign(n) {
  return `${n >= 0 ? "+" : ""}${num(n)}`;
}
function short(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  return n.toFixed(0);
}