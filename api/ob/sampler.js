// api/ob/sampler.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// ================== TUNING (veilig voor Vercel) ==================
const HARD_MAX_PER_RUN = 30;
const REQUEST_DELAY_MS = 120;

const OB_STALE_MS = 120 * 60 * 1000; // 120 min (UI "stale" is los van scan-stale)

const DEFAULT_SAMPLES_WINDOW_SEC = 6 * 3600;  // 6 uur fallback
const DEFAULT_SAMPLES_MAX = 24;
const DEFAULT_SAMPLES_TTL_SEC = 60 * 60 * 48; // 48 uur
const DEFAULT_RESULT_TTL_SEC = 60 * 30;       // 30 min

// ✅ 30m cadence: in 3 uur heb je max ~6 samples.
// samplesNeed=4 is precies jouw design.
const DEFAULT_SAMPLES_NEED_30M = 4;
const DEFAULT_MIN_AGREE_30M = 3;

// WATCHLIST
const WATCH_MAX = 120;
const WATCH_TTL_SEC = 60 * 60 * 12;
const WATCH_PREFER = 18;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function safeObj(x) { return x && typeof x === "object" ? x : null; }

function uniqueUpper(list) {
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const s = String(x || "").toUpperCase().trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// ================== BITGET V2 ORDERBOOK (SPOT) ==================
async function fetchBitgetOrderbookRaw(baseSymbol, limit = 100) {
  const base = String(baseSymbol || "").toUpperCase();
  if (!base) return { ok: false, status: 400, msg: "Missing symbol" };

  const pair = `${base}USDT`;
  const safeLimit = Math.max(5, Math.min(150, Number(limit) || 100));
  const type = "step0";

  const url =
    `https://api.bitget.com/api/v2/spot/market/orderbook?` +
    `symbol=${encodeURIComponent(pair)}&type=${encodeURIComponent(type)}&limit=${encodeURIComponent(String(safeLimit))}`;

  const r = await fetch(url, { headers: { accept: "application/json" } });
  const text = await r.text();

  let j = null;
  try { j = JSON.parse(text); } catch {}

  if (!r.ok) {
    return { ok: false, status: r.status, msg: j?.msg || "Bitget orderbook failed", url, preview: text.slice(0, 200) };
  }
  if (String(j?.code || "") !== "00000") {
    return { ok: false, status: 400, msg: j?.msg || "Bitget returned non-success code", url, preview: text.slice(0, 200) };
  }

  const depth = j?.data;
  if (!depth?.bids?.length || !depth?.asks?.length) {
    return { ok: false, status: 200, msg: "Empty orderbook", url, preview: text.slice(0, 200) };
  }

  return { ok: true, url, depth };
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let biggest = 0;

  for (const row of levels) {
    const p = Number(row?.[0]);
    const s = Number(row?.[1]);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;

    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;

    const usd = p * s;
    total += usd;
    if (usd > biggest) biggest = usd;
  }
  return { total, biggest };
}

function imbalanceScore(bidUsd, askUsd) {
  const denom = bidUsd + askUsd;
  return denom > 0 ? (bidUsd - askUsd) / denom : 0;
}

function computeObSample(depth) {
  const bids = depth?.bids || [];
  const asks = depth?.asks || [];
  if (!bids.length || !asks.length) return null;

  const bid = Number(bids[0]?.[0]);
  const ask = Number(asks[0]?.[0]);
  if (!(bid > 0) || !(ask > 0)) return null;

  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  // 0.2% band (score)
  const pct02 = 0.002;
  const bid02 = sumDepth(bids, mid, pct02, true);
  const ask02 = sumDepth(asks, mid, pct02, false);

  const bidUsd = bid02.total;
  const askUsd = ask02.total;

  const score = imbalanceScore(bidUsd, askUsd);
  const pressureDeltaUsd = bidUsd - askUsd;

  const denom02 = bidUsd + askUsd;
  const biggest02 = Math.max(bid02.biggest, ask02.biggest);
  const lor = denom02 > 0 ? biggest02 / denom02 : 1;

  // extra PRO: 0.5% en 1% imbalance
  const pct05 = 0.005;
  const bid05 = sumDepth(bids, mid, pct05, true);
  const ask05 = sumDepth(asks, mid, pct05, false);
  const score05p = imbalanceScore(bid05.total, ask05.total);

  const bid1 = sumDepth(bids, mid, 0.01, true);
  const ask1 = sumDepth(asks, mid, 0.01, false);
  const depthMinUsd1p = Math.min(bid1.total, ask1.total);
  const score1p = imbalanceScore(bid1.total, ask1.total);

  return {
    ts: Date.now(),
    mid,
    spreadPct,

    // core
    bidUsd,
    askUsd,
    score,
    pressureDeltaUsd,
    lor,
    depthMinUsd1p,

    // pro
    score05p,
    score1p,
  };
}

function pruneSamples(samples, SETTINGS) {
  const now = Date.now();
  const winSec = Number(SETTINGS?.entry?.samplesWindowSec || DEFAULT_SAMPLES_WINDOW_SEC);
  const winMs = winSec * 1000;

  const maxKeep = Math.max(6, Math.min(60, Number(SETTINGS?.entry?.samplesMax || DEFAULT_SAMPLES_MAX)));

  const arr = Array.isArray(samples) ? samples : [];
  return arr
    .map((s) => ({
      ts: Number(s?.ts || 0),
      score: Number(s?.score ?? 0),
      score05p: Number(s?.score05p ?? 0),
      score1p: Number(s?.score1p ?? 0),

      spreadPct: Number(s?.spreadPct ?? 999),
      lor: Number(s?.lor ?? 1),

      bidUsd: Number(s?.bidUsd ?? 0),
      askUsd: Number(s?.askUsd ?? 0),
      pressureDeltaUsd: Number(s?.pressureDeltaUsd ?? 0),

      mid: Number(s?.mid ?? 0),
      depthMinUsd1p: Number(s?.depthMinUsd1p ?? 0),
    }))
    .filter((s) => s.ts > 0 && Number.isFinite(s.score))
    .filter((s) => now - s.ts <= winMs)
    .sort((a, b) => a.ts - b.ts)
    .slice(-maxKeep);
}

function validateSamples(mode, samplesFresh, SETTINGS) {
  const fresh = pruneSamples(samplesFresh, SETTINGS);

  const need = Number(SETTINGS?.entry?.samplesNeed ?? DEFAULT_SAMPLES_NEED_30M);
  const minAgree = Number(SETTINGS?.entry?.minAgree ?? DEFAULT_MIN_AGREE_30M);

  if (fresh.length < need) return { valid: false, reason: "Not enough samples", fresh };

  const lastN = fresh.slice(-need);

  // direction op score (0.2%)
  const agree = lastN.filter((s) => (mode === "bull" ? s.score > 0 : s.score < 0)).length;
  const avgScore = lastN.reduce((a, s) => a + s.score, 0) / lastN.length;

  const avgOk = mode === "bull" ? avgScore > 0 : avgScore < 0;
  if (!avgOk || agree < minAgree) {
    return { valid: false, reason: "Direction not consistent", fresh: lastN, avgScore, agree };
  }

  // PRO: 1% score mag niet totaal de andere kant op flippen (milde check)
  const avgScore1p = lastN.reduce((a, s) => a + (s.score1p ?? 0), 0) / lastN.length;
  const score1pOk = mode === "bull" ? avgScore1p > -0.15 : avgScore1p < 0.15;

  if (!score1pOk) {
    return { valid: false, reason: "1% imbalance contradicts", fresh: lastN, avgScore, agree, avgScore1p };
  }

  return { valid: true, reason: "OK", fresh: lastN, avgScore, agree, avgScore1p };
}

// slope helper (per minuut)
// ✅ was: min 6 punten (fout voor 30m cadence) → nu min 4 / samplesNeed
function calcSlopeMin(samples, field, SETTINGS) {
  const need = Number(SETTINGS?.entry?.samplesNeed ?? DEFAULT_SAMPLES_NEED_30M);
  const minPts = Math.max(4, need);

  const pts = (samples || [])
    .map(s => ({ t: Number(s?.ts || 0), y: Number(s?.[field]) }))
    .filter(p => p.t > 0 && Number.isFinite(p.y))
    .sort((a, b) => a.t - b.t);

  if (pts.length < minPts) return 0;

  const tail = pts.slice(-minPts);

  const t0 = tail[0].t;
  const xs = tail.map(p => (p.t - t0) / 60000);
  const ys = tail.map(p => p.y);

  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    num += dx * (ys[i] - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

// ================== WATCHLIST LOGIC ==================
async function loadWatch(mode) {
  const key = `ob:watch:${mode}`;
  const w = await kv.get(key);
  return Array.isArray(w) ? uniqueUpper(w) : [];
}

async function saveWatch(mode, list) {
  const key = `ob:watch:${mode}`;
  const pruned = uniqueUpper(list).slice(0, WATCH_MAX);
  await kv.set(key, pruned, { ex: WATCH_TTL_SEC });
  return pruned;
}

function isBadSymbol(sym) {
  const s = String(sym || "").toUpperCase().trim();
  if (!s) return true;
  if (s.length > 18) return true;
  return false;
}

function addToWatch(watch, symbols) {
  const merged = uniqueUpper([...(watch || []), ...(symbols || [])]);
  return merged.slice(0, WATCH_MAX);
}

// ================== CANDIDATES SELECTIE ==================
// ✅ nu: RADAR + BUILDUP + ALMOST + ENTRY
async function pickCandidatesSmart(mode, latest, maxPerRun, radarFallback, SETTINGS, obMap) {
  const f = latest?.funnel || {};

  const take = (arr, n) => (Array.isArray(arr) ? arr.slice(0, Math.max(0, Number(n || 0))) : []);

  const pickEntry  = Number(SETTINGS?.obPickEntry  ?? 20);
  const pickAlmost = Number(SETTINGS?.obPickAlmost ?? 25);
  const pickBuildup= Number(SETTINGS?.obPickBuildup?? 25);
  const pickRadar  = Number(SETTINGS?.obPickRadar  ?? radarFallback ?? 25);

  const entry  = take(f.entry,   pickEntry);
  const almost = take(f.almost,  pickAlmost);
  const buildup= take(f.buildup, pickBuildup);
  const radar  = take(f.radar,   pickRadar);

  // ✅ prioriteit: ENTRY/ALMOST eerst, maar RADAR blijft erin
  const picked = [...entry, ...almost, ...buildup, ...radar];

  const poolNow = uniqueUpper(picked.map((x) => x?.symbol)).filter((s) => !isBadSymbol(s));

  const watch = await loadWatch(mode);
  const updatedWatch = await saveWatch(mode, addToWatch(watch, poolNow));

  const prefer = Math.max(1, Math.min(maxPerRun, WATCH_PREFER));
  let out = updatedWatch.slice(0, prefer);

  out = uniqueUpper([...out, ...poolNow]).slice(0, maxPerRun);

  // ✅ als obMap bestaat: alleen symbols samplen die we echt op Bitget kennen
  if (obMap) out = out.filter((sym) => !!obMap[String(sym).toUpperCase()]);

  return out.slice(0, maxPerRun);
}

// ================== PER COIN PROCESS ==================
async function processCandidate(core, mode, symbol, SETTINGS, keyObSamples, keyObResult) {
  const startedAt = Date.now();

  const live = await fetchBitgetOrderbookRaw(symbol, 100);
  if (!live.ok) return { ok: false, symbol, ...live };

  const sample = computeObSample(live.depth);
  if (!sample) {
    return { ok: false, symbol, status: 200, msg: "Could not compute sample", url: live.url };
  }

  const kS = keyObSamples(mode, symbol);
  const prev = (await kv.get(kS)) || [];
  const merged = Array.isArray(prev) ? prev.concat([sample]) : [sample];
  const pruned = pruneSamples(merged, SETTINGS);

  const samplesEx = Math.max(3600, Number(SETTINGS?.entry?.samplesTtlSec || DEFAULT_SAMPLES_TTL_SEC));
  await kv.set(kS, pruned, { ex: samplesEx });

  // ✅ validatie is “richting consistent + 1% check”
  const v = validateSamples(mode, pruned, SETTINGS);

  // ✅ bestaande slope gate uit core (matcht jouw core minPts=4)
  const slopeCheck = typeof core.checkObSlopeGate === "function"
    ? core.checkObSlopeGate({ stage: "sampler", mode, obSamples: pruned, settings: SETTINGS })
    : { ok: true, slope: 0, reason: "no-slope" };

  // extra pro: slopes (geen harde gates, puur info)
  const slopeDepth1p = calcSlopeMin(pruned, "depthMinUsd1p", SETTINGS);
  const slopeScore = calcSlopeMin(pruned, "score", SETTINGS);

  const finalValid = !!v.valid && !!slopeCheck.ok;
  const finalReason = finalValid
    ? "OK"
    : (v.valid ? (slopeCheck.reason || "OB slope failed") : (v.reason || "OB invalid"));

  // sample is altijd “vers”; stale is bedoeld voor UI als result oud blijft liggen
  const ageMs = Date.now() - sample.ts;
  const stale = ageMs > OB_STALE_MS;

  const result = {
    symbol,
    side: mode,

    valid: finalValid,
    reason: finalReason,

    stale,
    ageSec: Math.round(ageMs / 1000),

    // top-level quick fields
    score: sample.score,
    score05p: sample.score05p,
    score1p: sample.score1p,
    pressureDeltaUsd: sample.pressureDeltaUsd,

    spreadPct: sample.spreadPct,
    lor: sample.lor,
    depthMinUsd1p: sample.depthMinUsd1p,

    avgScore: v.avgScore ?? null,
    avgScore1p: v.avgScore1p ?? null,
    agree: v.agree ?? null,

    // slopes
    slope: slopeCheck.slope ?? null, // legacy
    slopeScore,
    slopeDepth1p,

    ob: {
      ts: sample.ts,
      mid: sample.mid,
      spreadPct: sample.spreadPct,

      bidUsd: sample.bidUsd,
      askUsd: sample.askUsd,

      score: sample.score,
      score05p: sample.score05p,
      score1p: sample.score1p,

      pressureDeltaUsd: sample.pressureDeltaUsd,

      lor: sample.lor,
      depthMinUsd1p: sample.depthMinUsd1p,

      slopeScore,
      slopeDepth1p,
    },

    tookMs: Date.now() - startedAt,
    ts: Date.now(),
  };

  const resultEx = Math.max(900, Number(SETTINGS?.entry?.resultTtlSec || DEFAULT_RESULT_TTL_SEC));
  await kv.set(keyObResult(mode, symbol), result, { ex: resultEx });

  return { ok: true, symbol, valid: finalValid, reason: finalReason };
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull/bear" }));
    }

    const rt = await import("../../lib/_runtime.js");
    if (!rt.requireSecret(req, res)) return;

    const core = await import(`../../lib/_core_${mode}.js`);
    const { SETTINGS, keyLatest, keyObSamples, keyObResult } = core;

    const maxPerRunRaw = Number(req.query?.max || 12) || 12;
    const maxPerRun = Math.max(1, Math.min(HARD_MAX_PER_RUN, Math.min(80, maxPerRunRaw)));

    const radarFallback = Math.max(5, Math.min(120, Number(req.query?.radar || 25) || 25));

    const obMapBlob = await kv.get(`ob:map:${mode}`);
    const obMap = safeObj(obMapBlob)?.map && typeof obMapBlob.map === "object" ? obMapBlob.map : null;

    const latest = await kv.get(keyLatest(mode));
    const candidatesRaw = await pickCandidatesSmart(mode, latest, maxPerRun, radarFallback, SETTINGS, obMap);

    const candidates = uniqueUpper(candidatesRaw).filter((s) => !isBadSymbol(s));

    let totalTried = 0;
    let totalProcessed = 0;
    let totalValid = 0;
    let failed = 0;

    const processed = [];
    const failedDetails = [];

    for (const sym of candidates) {
      totalTried++;
      if (totalTried > 1) await sleep(REQUEST_DELAY_MS);

      const r = await processCandidate(core, mode, sym, SETTINGS, keyObSamples, keyObResult);
      if (r.ok) {
        totalProcessed++;
        if (r.valid) totalValid++;
        processed.push({ symbol: sym, valid: r.valid, reason: r.reason });
      } else {
        failed++;
        failedDetails.push({
          symbol: r.symbol,
          status: r.status,
          msg: r.msg || r.error || "failed",
          url: r.url,
          preview: r.preview,
        });
      }
    }

    const watchNow = await loadWatch(mode);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({
      ok: true,
      mode,
      ts: Date.now(),
      cadenceHint: "Designed for 30m cron (samplesNeed=4 within 3h window).",
      maxPerRun,
      radarFallback,
      obMapOk: !!obMap,
      watchSize: watchNow.length,
      watchHead: watchNow.slice(0, 20),
      candidatesRaw,
      candidates,
      processed,
      totalTried,
      totalProcessed,
      totalValid,
      failed,
      failedDetails: failedDetails.slice(0, 20),
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}