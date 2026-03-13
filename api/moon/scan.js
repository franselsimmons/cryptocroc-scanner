// api/moon/scan.js
import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMoonLatest,
  keyMoonPortfolio,
  keyMoonPositions,
  keyMoonState,
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
  getTierForMcap,
  depthFloorUsd,
  computeMoonRisk,
  calcPnlPct,
  hitStopOrTp,
  isBlockedMoonAsset,
  MOON_V2,
  computeVelocity,
  computeCompression,
  computeBreakoutPressure,
  computePersistenceScore,
  computeMarketRegime,
  adjustMoonConfigForRegime,
  computeEliteQuality,
  computeBullMoveScore,
  computeBearMoveScore,
  isBullExhausted,
  isBearBounceTrap,
  computeMoonProbabilities,
} from "../../lib/_moon_core.js";

import { pushEvent, uid } from "../../lib/_analytics.js";
import { sendSignal } from "../../lib/discordRouter.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";

// ======================================================
// Hulpfunctie voor timeouts
// ======================================================
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

// ======================================================
// Veilige wrappers voor externe calls
// ======================================================
async function safePushEvent(name, payload) {
  try {
    await pushEvent(name, payload);
  } catch (e) {
    console.error(`pushEvent failed (${name}):`, e?.message || e);
  }
}

async function safeSendSignal(payload) {
  try {
    await sendSignal(payload);
  } catch (e) {
    console.error("sendSignal failed:", e?.message || e);
  }
}

// ======================================================
// Constantes
// ======================================================
const COOLDOWN_SL_SEC = 4 * 60 * 60;
const COOLDOWN_TP_SEC = 90 * 60;
const COOLDOWN_TIMEOUT_SEC = 2 * 60 * 60;
const COOLDOWN_EARLY_EXIT_SEC = 60 * 60;   // early exit cooldown 1 uur

const MAX_OPEN_TRADES = 4;
const TIMEOUT_BARS = 16;
const TIMEOUT_MIN_PNL_PCT = 1.0;

const ENTRY_HISTORY_KEEP = 40;
const ENTRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_RECENT_ENTRIES_TARGET = 2;

// Hysteresis / state machine drempels
const STRONG_SCANS_NEEDED_FOR_ENTRY = 2;
const THESIS_BREAK_SCANS_FOR_EXIT = 2;
const MIN_HOLD_BARS_BEFORE_SOFT_EXIT = 2;
const MIN_ELITE_SCANS_BEFORE_ENTRY = 1;

// Positiegrootte (vast bedrag in USD)
const POSITION_SIZE_USD = 50;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function up(x) {
  return String(x || "").toUpperCase();
}

// ======================================================
// Boundary-based lock (15 min)
// ======================================================
function scanLockKey(mode) {
  return `moon:scan:lock:${String(mode || "bull").toLowerCase()}`;
}

async function acquireScanLock(mode) {
  const key = scanLockKey(mode);
  const now = Date.now();

  const d = new Date(now);
  const next = new Date(d);
  next.setSeconds(0, 0);

  const m = d.getMinutes();
  if (m < 15) next.setMinutes(15);
  else if (m < 30) next.setMinutes(30);
  else if (m < 45) next.setMinutes(45);
  else {
    next.setMinutes(0);
    next.setHours(d.getHours() + 1);
  }

  const until = next.getTime();
  const ttlSec = Math.max(60, Math.ceil((until - now) / 1000));

  const ok = await kv.set(key, { ts: now, until, mode }, { nx: true, ex: ttlSec });

  if (ok) return { ok: true, key, until };

  const cur = await kv.get(key);
  const curUntil = Number(cur?.until || 0);

  if (curUntil > now) {
    return { ok: false, key, until: curUntil };
  }

  // lock expired – overschrijven
  await kv.set(key, { ts: now, until, mode }, { ex: ttlSec });
  return { ok: true, key, until };
}

async function releaseScanLock(mode) {
  try {
    await kv.del(scanLockKey(mode));
  } catch {}
}

// ======================================================
// Cooldown helpers
// ======================================================
function cooldownKey(mode, symbol) {
  return `moon:cooldown:${String(mode || "bull").toLowerCase()}:${up(symbol)}`;
}

function entryHistoryKey(mode) {
  return `moon:entry:history:${String(mode || "bull").toLowerCase()}`;
}

async function readRecentEntryCount(mode, lookbackMs = ENTRY_LOOKBACK_MS) {
  const key = entryHistoryKey(mode);
  const now = Date.now();
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const filtered = arr.filter((ts) => n(ts, 0) >= now - lookbackMs).slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, filtered, { ex: 60 * 60 * 24 * 3 });
  return filtered.length;
}

async function appendEntryHistory(mode) {
  const key = entryHistoryKey(mode);
  const now = Date.now();
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const next = [now, ...arr].slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, next, { ex: 60 * 60 * 24 * 3 });
}

function isMoonEliteStage(stage) {
  const s = up(stage);
  return s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE";
}

// ======================================================
// Externe data met timeouts
// ======================================================
async function fetchExchangeFlows() {
  try {
    const data = await fetchJsonWithTimeout("https://api.binance.com/api/v3/ticker/24hr", {}, 8000);
    return data.filter((x) => Number(x.quoteVolume) > 200_000_000).length;
  } catch {
    return 0;
  }
}

async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}&type=step0&limit=20`;
    const j = await fetchJsonWithTimeout(url, { headers: { accept: "application/json" } }, 6000);
    if (String(j?.code || "") !== "00000") return null;

    const bids = j?.data?.bids || [];
    const asks = j?.data?.asks || [];
    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0]?.[0], 0);
    const bestAsk = n(asks[0]?.[0], 0);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
    const depthBidUsd = bids.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);
    const depthAskUsd = asks.slice(0, 8).reduce((a, b) => a + n(b?.[1]) * n(b?.[0]), 0);
    const total = depthBidUsd + depthAskUsd;
    const score = total > 0 ? (depthBidUsd - depthAskUsd) / total : 0;
    const largestBidUsd = Math.max(...bids.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])), 0);
    const largestAskUsd = Math.max(...asks.slice(0, 8).map((b) => n(b?.[1]) * n(b?.[0])), 0);
    const largestOrderRatio = total > 0 ? Math.max(largestBidUsd, largestAskUsd) / total : 0;

    return {
      status: "ok",
      valid: true,
      fresh: true,
      stale: false,
      reason: "",
      spreadPct,
      depthBidUsd,
      depthAskUsd,
      depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd),
      score,
      lor: largestOrderRatio,
    };
  } catch {
    return null;
  }
}

// ... (de rest van de code: computeObScore, buildTradePlan, sortByStageScore, splitFunnels, makePortfolio,
//      isLateBullEntry, isLateBearEntry, hasEliteFollowThrough, decideMoonStageV6, buildUniverse,
//      canPromoteBalancedEntry, applyFunnelBalancer, calculateThesisDamage, isThesisStillValid)
// Deze functies blijven ongewijzigd, alleen de aanroep van fetchOrderbook in buildUniverse gebruikt nu de nieuwe versie.

async function buildUniverse(mode, whaleFlow, btc) {
  const regime = computeMarketRegime({ btc, whaleFlow, mode });

  const rawCoins = await fetchCoinGeckoTopCached(); // gebruikt al fetchJsonWithTimeout (moet ook aangepast, zie onder)
  const bitgetSymbols = await getBitgetSpotUsdtSymbols(); // moet ook timeout

  const step1 = rawCoins.filter((c) => !isBlockedMoonAsset(c));
  const step2 = step1.filter((c) => bitgetSymbols.has(up(c.symbol)));

  console.log("🔍 MOON V6 DEBUG", {
    regime,
    rawCoins: rawCoins.length,
    afterBlocked: step1.length,
    bitgetSymbols: bitgetSymbols.size,
    afterBitget: step2.length,
    sampleCg: step1.slice(0, 10).map((c) => c.symbol),
    sampleBitget: Array.from(bitgetSymbols).slice(0, 20),
  });

  // 🔻 Verlaagd aantal coins voor lagere belasting
  const filtered = step2.slice(0, 140);
  const out = [];
  const state = (await kv.get(keyMoonState(mode))) || {};

  for (const coin of filtered) {
    const sym = up(coin.symbol);
    const prev = state?.[sym] || {};

    let ob = null;
    if (n(coin.volume, 0) >= 600_000) {
      ob = await fetchOrderbook(`${sym}USDT`); // gebruikt nu timeout
    }

    const obx = computeObScore(ob);
    const tier = getTierForMcap(coin.marketCap);
    const floorUsd = depthFloorUsd(coin.marketCap, tier, prev?.depthHist);
    const depthUsd = n(obx.depthMinUsd1p, 0);
    const depthOk = depthUsd >= floorUsd;

    const priceHist = Array.isArray(prev?.priceHist) ? [...prev.priceHist] : [];
    const volHist = Array.isArray(prev?.volHist) ? [...prev.volHist] : [];

    priceHist.push(n(coin.price, 0));
    volHist.push(n(coin.volume, 0));

    const priceHistNext = priceHist.slice(-120);
    const volHistNext = volHist.slice(-120);

    const volAcc = { short: 1, medium: 1 };
    if (volHistNext.length >= 5) {
      const nowVol = volHistNext[volHistNext.length - 1];
      const shortAgo = volHistNext[volHistNext.length - 1 - 5] || nowVol;
      const mediumAgo = volHistNext[volHistNext.length - 1 - 20] || nowVol;
      volAcc.short = nowVol / Math.max(shortAgo, 1e-9);
      volAcc.medium = nowVol / Math.max(mediumAgo, 1e-9);
    }

    const stageDecision = decideMoonStageV6({
      mode,
      coin,
      obx,
      priceHist: priceHistNext,
      volHist: volHistNext,
      btc,
      prev: { ...prev, volAcc },
      whaleFlow,
      regime,
    });

    const stage = stageDecision.stage;
    const stageWhy = stageDecision.stageWhy;
    const eliteType = stageDecision.eliteType;
    const velocity = stageDecision.velocity;
    const compression = stageDecision.compression;
    const breakout = stageDecision.breakout;
    const moveScore = stageDecision.moveScore;
    const persistenceScore = stageDecision.persistenceScore;
    const entryQuality = stageDecision.entryQuality;

    const probs = computeMoonProbabilities({
      mode,
      coin: { ...coin, ob: obx },
      moveScore,
      velocity,
      compression,
      persistenceScore,
    });

    const tradePlan = buildTradePlan({
      price: n(coin.price, 0),
      mode,
      confidence: entryQuality || moveScore,
      range24: n(coin.range24, 0),
      depthOk,
      tier,
      regime,
      persistenceScore,
    });

    out.push({
      id: coin.id,
      symbol: sym,
      name: coin.name || "",
      image: coin.image || "",
      price: n(coin.price, 0),
      marketCap: n(coin.marketCap, 0),
      volume: n(coin.volume, 0),
      change24: n(coin.change24, 0),
      change1h: n(coin.change1h, 0),
      vm: n(coin.vm, 0),
      confidence: moveScore,
      entryQuality,
      persistenceScore,
      marketRegime: regime,
      stage,
      stageWhy,
      eliteType,
      tier: tier?.name || "unknown",
      ob: {
        spreadPct: Number(obx.spreadPct.toFixed(4)),
        depthBidUsd: Math.round(obx.depthBidUsd),
        depthAskUsd: Math.round(obx.depthAskUsd),
        score: Number(obx.score.toFixed(5)),
        depthMinUsd1p: Math.round(obx.depthMinUsd1p),
        valid: obx.valid,
        fresh: obx.fresh,
        stale: obx.stale,
        reason: obx.reason,
        lor: Number(n(obx.lor, 0).toFixed(4)),
      },
      thresholds: {
        depthFloorUsd: Math.round(floorUsd),
        depthOk,
      },
      compression: {
        isCompressed: compression.isCompressed,
        flatPct: compression.flatPct,
      },
      breakout: {
        ready: !!breakout?.ready,
        breakoutPct: Number(n(breakout?.breakoutPct, 0).toFixed(3)),
        pressure: Number(n(breakout?.pressure, 0).toFixed(2)),
      },
      volAcc: {
        short: Number(volAcc.short.toFixed(3)),
        medium: Number(volAcc.medium.toFixed(3)),
      },
      moveScore,
      velocity: Number(velocity.toFixed(3)),
      moonProbability: probs.moonProbability,
      dumpProbability: probs.dumpProbability,
      tradePlan: tradePlan
        ? {
            entry: Number(tradePlan.entry.toFixed(8)),
            sl: Number(tradePlan.sl.toFixed(8)),
            tp: Number(tradePlan.tp.toFixed(8)),
            rr: Number(tradePlan.rr.toFixed(2)),
            tpPct: Number(n(tradePlan.tpPct, 0).toFixed(2)),
            slPct: Number(n(tradePlan.slPct, 0).toFixed(2)),
          }
        : null,
      _state: {
        priceHist: priceHistNext,
        volHist: volHistNext,
        stageHist: (prev?.stageHist || []).concat([stage]).slice(-12),
        volAcc,
      },
    });

    // 🔻 Kortere pauze
    await sleep(10);
  }

  return { regime, coins: out };
}

// ======================================================
// FUNNEL BALANCER – alleen in noodgevallen en voor sterke coins
// ======================================================
function canPromoteBalancedEntry(coin, mode, regime) {
  if (!coin) return false;
  if (coin.tradePlan == null) return false;
  if (up(coin.stage) !== "ALMOST") return false;
  if (String(regime || "").toUpperCase() === "HEADWIND") return false;

  const eq = n(coin.entryQuality, 0);
  const ps = n(coin.persistenceScore, 0);
  const brReady = !!coin?.breakout?.ready;
  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  const ob = n(coin?.ob?.score, 0);

  if (eq < 68) return false;
  if (ps < 55) return false;
  if (!brReady) return false;
  if (v1 < 1.03 && v2 < 1.07) return false;

  if (mode === "bull" && ob < -0.01) return false;
  if (mode === "bear" && ob > 0.01) return false;

  return true;
}

function applyFunnelBalancer({ funnel, mode, regime, openCount, recentEntryCount }) {
  if (!funnel) return funnel;
  if (openCount >= MAX_OPEN_TRADES) return funnel;
  if (recentEntryCount >= MIN_RECENT_ENTRIES_TARGET) return funnel;
  if ((funnel.elite_expansion?.length || 0) + (funnel.elite_ignition?.length || 0) > 0) return funnel;

  const almost = Array.isArray(funnel.almost) ? [...funnel.almost] : [];
  if (!almost.length) return funnel;

  const idx = almost.findIndex((coin) => canPromoteBalancedEntry(coin, mode, regime));
  if (idx === -1) return funnel;

  const promoted = {
    ...almost[idx],
    stage: "ELITE_IGNITION",
    eliteType: "ignition",
    stageWhy: "funnel_balancer_promoted",
  };

  almost.splice(idx, 1);

  return {
    ...funnel,
    almost,
    elite_ignition: [promoted, ...(funnel.elite_ignition || [])].slice(0, 12),
  };
}

// ======================================================
// Gewogen thesis‑validatie (damage‑score)
// ======================================================
function calculateThesisDamage(coin, prevState, mode) {
  let damage = 0;
  const reasons = {};

  // OB contra (zwaar)
  const obScore = n(coin?.ob?.score, 0);
  if (mode === "bull" && obScore < -0.02) {
    damage += 2;
    reasons.obContra = true;
  }
  if (mode === "bear" && obScore > 0.02) {
    damage += 2;
    reasons.obContra = true;
  }

  // Volume acceleratie weg (licht)
  const v1 = n(coin?.volAcc?.short, 1);
  const v2 = n(coin?.volAcc?.medium, 1);
  if (v1 < 1.01 && v2 < 1.04) {
    damage += 1;
    reasons.volDead = true;
  }

  // Breakout‑ready verdwenen (licht)
  if (!coin?.breakout?.ready) {
    damage += 1;
    reasons.breakoutLost = true;
  }

  // Persistence gedaald (zwaar)
  const ps = n(coin?.persistenceScore, 0);
  const prevPs = n(prevState?.persistenceScore, 0);
  if (ps < prevPs - 15) {
    damage += 2;
    reasons.persistDrop = true;
  }

  return { damage, reasons };
}

function isThesisStillValid(coin, prevState, mode) {
  const { damage } = calculateThesisDamage(coin, prevState, mode);
  return damage < 3; // drempelwaarde
}

export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;

  try {
    if (!requireSecret(req, res)) return;
    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    // === NIEUW: boundary lock met fallback naar laatste snapshot ===
    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(keyMoonLatest(mode));

      res.statusCode = 200;
      res.setHeader("content-type", "application/json");

      if (latest) {
        return res.end(
          JSON.stringify({
            ...latest,
            meta: {
              ...(latest.meta || {}),
              scanLock: {
                active: true,
                until: lock.until || null,
              },
            },
          })
        );
      }

      return res.end(
        JSON.stringify({
          ok: true,
          skipped: true,
          reason: "scan_lock_active",
          mode,
        })
      );
    }
    lockAcquired = true;

    const now = Date.now();
    const whaleFlow = await fetchExchangeFlows(); // gebruikt timeout
    const btc = await fetchBTCGateFromUniverse(); // moet ook timeout (zie core)

    const built = await buildUniverse(mode, whaleFlow, btc);
    const universe = built.coins;
    const regime = built.regime;

    const prevPositions = (await kv.get(keyMoonPositions(mode))) || { open: [], closed: [] };
    const positions = {
      open: Array.isArray(prevPositions?.open) ? [...prevPositions.open] : [],
      closed: Array.isArray(prevPositions?.closed) ? [...prevPositions.closed] : [],
    };

    const prevState = (await kv.get(keyMoonState(mode))) || {};
    const nextState = {};

    const universeMap = new Map();
    for (const c of universe) universeMap.set(c.symbol, c);

    const openMap = new Map(positions.open.map((p) => [up(p.symbol), p]));

    let funnel = splitFunnels(universe);
    const recentEntryCount = await readRecentEntryCount(mode);

    funnel = applyFunnelBalancer({
      funnel,
      mode,
      regime,
      openCount: positions.open.length,
      recentEntryCount,
    });

    // ------------------------------------------------------------
    // 1) State‑machine voor elke coin (zonder open positie)
    // ------------------------------------------------------------
    for (const coin of universe) {
      const sym = up(coin.symbol);
      const prev = prevState?.[sym] || null;
      const hasOpenPosition = openMap.has(sym);
      if (hasOpenPosition) continue; // apart behandelen

      const rawStage = up(coin.stage || "");
      const prevStage = up(prev?.stage || ""); // niet gebruikt, maar kan blijven

      // Teller bijwerken – met reset van strongScans zodra elite wegvalt
      let strongScans = 0;
      let weakScans = prev?.weakScans || 0;
      let thesisInvalidScans = prev?.thesisInvalidScans || 0;
      let entryLocked = prev?.entryLocked || false;
      let eliteScans = 0;
      let candidateSince = prev?.candidateSince || null;
      let eliteSince = prev?.eliteSince || null;

      if (rawStage === "RADAR") {
        // Harde reset
        weakScans = 0;
        thesisInvalidScans = 0;
        candidateSince = null;
        eliteSince = null;
        entryLocked = false; // unlock bij rad
      } else {
        if (isMoonEliteStage(rawStage)) {
          strongScans = (prev?.strongScans || 0) + 1;
          eliteScans = (prev?.eliteScans || 0) + 1;
        } else {
          strongScans = 0;
          eliteScans = 0;
        }

        if (rawStage === "RADAR") {
          weakScans = (prev?.weakScans || 0) + 1;
        } else if (rawStage === "BUILDUP") {
          weakScans = prev?.weakScans || 0; // behouden
        } else {
          weakScans = 0; // ALMOST/ELITE reset weak
        }

        if (rawStage === "RADAR") {
          candidateSince = null;
        } else {
          candidateSince = prev?.candidateSince;
          if (!candidateSince && (rawStage === "BUILDUP" || rawStage === "ALMOST" || isMoonEliteStage(rawStage))) {
            candidateSince = now;
          }
        }

        if (isMoonEliteStage(rawStage)) {
          if (!prev?.eliteSince || !isMoonEliteStage(prev?.stage || "")) {
            eliteSince = now;
          } else {
            eliteSince = prev.eliteSince;
          }
        } else {
          eliteSince = null;
        }

        thesisInvalidScans = prev?.thesisInvalidScans || 0;
        entryLocked = prev?.entryLocked || false;
      }

      // Depth-historie correct bijwerken
      let depthHist = Array.isArray(prev?.depthHist) ? [...prev.depthHist] : [];
      const currentDepth = n(coin.ob?.depthMinUsd1p, 0);
      if (currentDepth > 0) {
        depthHist.push(currentDepth);
      } else {
        // behoud oude waarden als depth ontbreekt (geen vervuiling met 0)
        // niets toevoegen
      }
      depthHist = depthHist.slice(-20); // max 20 entries

      // tradePlan en thesis-info opslaan in nextState
      const thesisInfo = calculateThesisDamage(coin, prev, mode);
      const tradePlan = coin.tradePlan; // kan null zijn

      // entryReady berekenen (alleen voor coins zonder positie) – inclusief ELITE_CASCADE
      let entryReady = false;
      if (!hasOpenPosition) {
        entryReady = (
          (rawStage === "ELITE_IGNITION" || rawStage === "ELITE_EXPANSION" || rawStage === "ELITE_CASCADE") &&
          strongScans >= STRONG_SCANS_NEEDED_FOR_ENTRY &&
          eliteScans >= MIN_ELITE_SCANS_BEFORE_ENTRY &&
          candidateSince != null &&
          eliteSince != null &&
          entryLocked === false &&
          thesisInvalidScans === 0 &&
          coin.tradePlan != null &&
          coin.breakout?.ready === true &&
          coin.thresholds?.depthOk === true &&
          coin.ob?.valid === true &&
          (coin.entryQuality || 0) >= 68 &&
          (coin.persistenceScore || 0) >= 60
        );
      }

      // Alles in nextState stoppen
      nextState[sym] = {
        ...prev,
        stage: rawStage,
        stageWhy: coin.stageWhy,
        eliteType: coin.eliteType,
        price: coin.price,
        marketCap: coin.marketCap,
        volume: coin.volume,
        change24: coin.change24,
        change1h: coin.change1h,
        vm: coin.vm,
        confidence: coin.confidence,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        moveScore: coin.moveScore,
        velocity: coin.velocity,
        moonProbability: coin.moonProbability,
        dumpProbability: coin.dumpProbability,
        ob: coin.ob,
        thresholds: coin.thresholds,
        compression: coin.compression,
        breakout: coin.breakout,
        volAcc: coin.volAcc,
        tradePlan: tradePlan,
        thesisDamage: thesisInfo.damage,
        thesisReasons: thesisInfo.reasons,
        priceHist: coin._state.priceHist,
        volHist: coin._state.volHist,
        stageHist: coin._state.stageHist,
        depthHist,
        strongScans,
        weakScans,
        thesisInvalidScans,
        eliteScans,
        candidateSince,
        eliteSince,
        entryLocked,
        entryReady,
        lastSeen: now,
      };
    } // einde for-loop over universe

    // ------------------------------------------------------------
    // 2) Open posities verwerken (exits, thesis, state-updates)
    // ------------------------------------------------------------
    const updatedOpen = [];
    for (const pos of positions.open) {
      const sym = up(pos.symbol);
      const coin = universeMap.get(sym);
      const now = Date.now();

      // Haal de laatste state op (eerst nextState, anders prevState)
      let coinState = nextState[sym] || prevState?.[sym] || {};
      const prevCoinState = prevState?.[sym] || {};

      // Bereken huidige damage
      let thesisDamage = coin ? calculateThesisDamage(coin, coinState, mode) : { damage: 0, reasons: {} };
      if (!coin) {
        thesisDamage = { damage: coinState.thesisDamage || 0, reasons: coinState.thesisReasons || {} };
      }

      // Thesis invalid scans tellen
      let thesisInvalidScans = coinState.thesisInvalidScans || 0;
      if (!isThesisStillValid(coin, coinState, mode)) {
        thesisInvalidScans++;
      } else {
        thesisInvalidScans = Math.max(0, thesisInvalidScans - 1); // licht herstel
      }

      // Entry lock: tijdens open positie altijd true
      let entryLocked = true;

      // P&L berekenen met helper
      const priceNow = coin?.price || pos.lastPrice;
      const pnlPct = calcPnlPct({
        mode: pos.mode || mode,
        entryPrice: pos.entryPrice,
        priceNow,
      });
      const barsHeld = Math.floor((now - pos.entryAt) / (15 * 60 * 1000)); // 15min bars voor Moon

      // TP / SL check
      const hit = coin
        ? hitStopOrTp({
            mode: pos.mode || mode,
            priceNow: coin.price,
            sl: pos.sl,
            tp3: pos.tp,
          })
        : { hit: false };

      let exitReason = null;
      if (hit.hit && hit.kind === "SL") exitReason = "stop_loss";
      else if (hit.hit && hit.kind === "TP") exitReason = "take_profit";

      // Timeout
      if (!exitReason && barsHeld >= TIMEOUT_BARS && pnlPct < TIMEOUT_MIN_PNL_PCT) {
        exitReason = "timeout";
      }

      // Thesis break (early exit)
      if (!exitReason && thesisInvalidScans >= THESIS_BREAK_SCANS_FOR_EXIT && barsHeld >= MIN_HOLD_BARS_BEFORE_SOFT_EXIT) {
        exitReason = "thesis_break";
      }

      if (exitReason) {
        // Positie sluiten
        const pnlUsd = (pos.sizeUsd * pnlPct) / 100; // pnlPct is percentage
        const closedPos = {
          ...pos,
          exitPrice: priceNow,
          exitAt: now,
          pnlUsd,
          pnlPct,
          exitReason,
        };
        positions.closed.push(closedPos);

        // Cooldown instellen
        const cdKey = cooldownKey(mode, sym);
        let cdSec = COOLDOWN_SL_SEC;
        if (exitReason === "take_profit") cdSec = COOLDOWN_TP_SEC;
        else if (exitReason === "timeout") cdSec = COOLDOWN_TIMEOUT_SEC;
        else if (exitReason === "thesis_break") cdSec = COOLDOWN_EARLY_EXIT_SEC;
        await kv.set(cdKey, now + cdSec * 1000, { ex: cdSec * 2 });

        // State resetten voor deze coin – entryLocked blijft true
        nextState[sym] = {
          ...coinState,
          entryActive: false,
          entryLocked: true,
          candidateSince: null,
          eliteScans: 0,
          strongScans: 0,
          weakScans: 0,
          thesisInvalidScans: 0,
          entryReady: false,
          lastExit: now,
          lastExitReason: exitReason,
        };

        // Event: trade_closed
        await safePushEvent("trade_closed", {
          id: pos.id,
          mode,
          symbol: sym,
          entry: pos.entryPrice,
          exit: closedPos.exitPrice,
          pnlPct: closedPos.pnlPct,
          pnlUsd: closedPos.pnlUsd,
          reason: exitReason,
          holdBars: barsHeld,
        });

        // Signal voor Discord – bouw een minimaal coin object als coin niet meer in universe zit
        const coinForSignal = coin || {
          symbol: sym,
          price: coinState.price,
          change1h: coinState.change1h,
          change24: coinState.change24,
          vm: coinState.vm,
          ob: coinState.ob,
          tradePlan: coinState.tradePlan,
          stage: coinState.stage,
        };
        await safeSendSignal({
          source: "moon",
          stage: coinState.stage || "",
          mode,
          coin: coinForSignal,
          btcState: btc?.state || "NEUTRAL",
          kind: "trade_closed",
          pnl: closedPos.pnlPct,
          reason: exitReason,
        });

        // Niet toevoegen aan updatedOpen
      } else {
        // Positie blijft open: werk bij met laatste prijs, pnl en state
        const pnlUsd = (pos.sizeUsd * pnlPct) / 100;
        const updatedPos = {
          ...pos,
          lastPrice: priceNow,
          lastUpdate: now,
          pnlPct,
          pnlUsd,
        };
        updatedOpen.push(updatedPos);

        // Werk coinState bij voor deze positie (thesisInvalidScans, etc.) – entryLocked hard true
        nextState[sym] = {
          ...coinState,
          thesisInvalidScans,
          thesisDamage: thesisDamage.damage,
          thesisReasons: thesisDamage.reasons,
          entryLocked: true,
          entryActive: true,
          entryReady: false,
          lastPrice: priceNow,
          pnlPct,
          pnlUsd,
        };

        // Event: scan_hold (alleen bij belangrijke wijzigingen)
        const prevPnl = coinState.pnlPct || 0;
        const stageNow = coin?.stage || coinState.stage || "";
        if (Math.abs(pnlPct - prevPnl) >= 2.0 || thesisDamage.damage !== (coinState.thesisDamage || 0) || stageNow !== coinState.stage) {
          await safePushEvent("scan_hold", {
            mode,
            symbol: sym,
            stage: stageNow,
            pnlPct,
            thesisDamage: thesisDamage.damage,
            reasons: thesisDamage.reasons,
          });
        }
      }
    }

    // Vervang open posities door de bijgewerkte lijst
    positions.open = updatedOpen;

    // ------------------------------------------------------------
    // 3) Nieuwe entries openen op basis van entryReady
    // ------------------------------------------------------------
    // Haal alle coins met entryReady uit nextState
    const entryCandidates = [];
    for (const sym of Object.keys(nextState)) {
      const state = nextState[sym];
      if (state.entryReady && !openMap.has(sym)) {
        // Controleer of coin nog in universe zit (anders geen tradePlan)
        const coin = universeMap.get(sym);
        if (!coin || !coin.tradePlan) continue;

        // Cooldown check – veilig met n()
        const cdKey = cooldownKey(mode, sym);
        const cdUntil = await kv.get(cdKey);
        if (n(cdUntil, 0) > now) continue; // nog in cooldown

        entryCandidates.push({ sym, state, coin });
      }
    }

    // Sorteer op entryQuality (hoogste eerst)
    entryCandidates.sort((a, b) => (b.coin.entryQuality || 0) - (a.coin.entryQuality || 0));

    // Beperk tot MAX_OPEN_TRADES minus huidige open posities
    const slotsLeft = MAX_OPEN_TRADES - positions.open.length;
    const toOpen = entryCandidates.slice(0, slotsLeft);

    for (const candidate of toOpen) {
      const { sym, coin, state } = candidate;

      // Genereer uniek ID met prefix
      const id = uid("moon");

      // Maak nieuwe positie
      const newPos = {
        id,
        symbol: sym,
        mode,
        status: "OPEN",
        entryAt: now,
        entryPrice: coin.tradePlan.entry,
        lastPrice: coin.price,
        sizeUsd: POSITION_SIZE_USD,
        pnlPct: 0,
        pnlUsd: 0,
        tp: coin.tradePlan.tp,
        sl: coin.tradePlan.sl,
        rr: coin.tradePlan.rr,
        tpPct: coin.tradePlan.tpPct,
        slPct: coin.tradePlan.slPct,
        entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore,
        regime,
        stage: coin.stage,
        eliteType: coin.eliteType,
      };

      positions.open.push(newPos);

      // Update nextState: entryLocked = true, entryReady = false, entryActive = true
      nextState[sym] = {
        ...state,
        entryActive: true,
        entryLocked: true,
        entryReady: false,
        lastEntryAt: now,
      };

      // Entry history bijwerken
      await appendEntryHistory(mode);

      // Events pushen
      await safePushEvent("trade_opened", {
        id,
        mode,
        symbol: sym,
        entry: newPos.entryPrice,
        size: newPos.sizeUsd,
        tp: newPos.tp,
        sl: newPos.sl,
        rr: newPos.rr,
        stage: newPos.stage,
        eliteType: newPos.eliteType,
      });

      await safeSendSignal({
        source: "moon",
        stage: coin.stage,
        mode,
        coin: coin,
        btcState: btc?.state || "NEUTRAL",
        kind: "trade_opened",
      });
    }

    // ------------------------------------------------------------
    // 4) Portfolio opbouwen en opslaan (met TTL)
    // ------------------------------------------------------------
    const portfolio = makePortfolio(mode, positions);
    await kv.set(keyMoonPortfolio(mode), portfolio, { ex: 60 * 60 * 24 * 7 });

    // ------------------------------------------------------------
    // 5) State en positions opslaan (closed capped)
    // ------------------------------------------------------------
    positions.closed = positions.closed.slice(-1000); // max 1000 closed trades bewaren
    await kv.set(keyMoonState(mode), nextState, { ex: 60 * 60 * 24 * 3 });
    await kv.set(keyMoonPositions(mode), positions, { ex: 60 * 60 * 24 * 7 });

    // ------------------------------------------------------------
    // 6) Latest snapshot opslaan
    // ------------------------------------------------------------
    const holdCoins = positions.open
      .map(p => {
        const coin = universeMap.get(p.symbol);
        if (!coin) return null;
        return {
          ...coin,
          stage: "HOLD",
          pnlPct: p.pnlPct,
          holdTime: Math.floor((now - p.entryAt) / (60 * 1000)),
        };
      })
      .filter(Boolean);

    holdCoins.sort((a, b) => Math.abs(b.pnlPct) - Math.abs(a.pnlPct));

    const responseFunnel = {
      ...funnel,
      hold: holdCoins.slice(0, 20),
    };

    const latest = {
      ok: true,
      mode,
      regime,
      funnel: responseFunnel,
      portfolio,
      positions: {
        open: positions.open.length,
        closed: positions.closed.length,
      },
      scannedAt: now,
    };

    await kv.set(keyMoonLatest(mode), latest, { ex: 60 * 60 });

    res.status(200).json(latest);
  } catch (err) {
    console.error("Moon scan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (lockAcquired) await releaseScanLock(mode);
  }
}