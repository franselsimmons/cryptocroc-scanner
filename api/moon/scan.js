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
  isBlockedMoonAsset,
} from "../../lib/_moon_core.js";

import { pushEvent, uid } from "../../lib/_analytics.js";
import { sendSignal } from "../../lib/discordRouter.js";
import { buildCoinProfile, buildMoonExecutionDecision } from "../../lib/_trade_engine.js";

// ========== helpers ==========
function n(x, d = 0) { const v = Number(x); return Number.isFinite(v) ? v : d; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function up(x) { return String(x || "").toUpperCase(); }
function sideFromMode(mode) { return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG"; }

function coinForDiscord({ coin, position }) {
  const plan = coin?.tradePlan || coin?.execution?.meta?.tradePlan || null;
  const entry = position?.entryPrice ?? plan?.entry ?? coin?.entry ?? coin?.price ?? null;
  const tp = position?.tp ?? plan?.tp ?? coin?.tp ?? null;
  const sl = position?.sl ?? plan?.sl ?? coin?.sl ?? null;
  return { ...coin, entry, tp, sl, tradePlan: plan };
}

async function safeSendSignal(payload) { try { await sendSignal(payload); } catch(e) { console.error("sendSignal failed:", e?.message || e); } }
async function safePushEvent(name, payload) { try { await pushEvent(name, payload); } catch(e) { console.error(`pushEvent failed (${name}):`, e?.message || e); } }

// ========== constants ==========
const COOLDOWN_SL_SEC = 4 * 60 * 60;
const COOLDOWN_TP_SEC = 90 * 60;
const COOLDOWN_TIMEOUT_SEC = 2 * 60 * 60;
const COOLDOWN_EARLY_EXIT_SEC = 60 * 60;
const MAX_OPEN_TRADES = 4;
const POSITION_SIZE_USD = 50;
const ENTRY_HISTORY_KEEP = 40;
const ENTRY_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MIN_RECENT_ENTRIES_TARGET = 2;
const UI_ENTRY_LOCK_MS_MOON = 8 * 60 * 60 * 1000;

// ========== lock (15 min boundaries) ==========
function scanLockKey(mode) { return `moon:scan:lock:${String(mode || "bull").toLowerCase()}`; }
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
  else { next.setMinutes(0); next.setHours(d.getHours() + 1); }
  const until = next.getTime();
  const ttlSec = Math.max(60, Math.ceil((until - now) / 1000));
  const ok = await kv.set(key, { ts: now, until, mode }, { nx: true, ex: ttlSec });
  if (ok) return { ok: true, key, until };
  const cur = await kv.get(key);
  const curUntil = Number(cur?.until || 0);
  if (curUntil > now) return { ok: false, key, until: curUntil };
  await kv.set(key, { ts: now, until, mode }, { ex: ttlSec });
  return { ok: true, key, until };
}
async function releaseScanLock(mode) { try { await kv.del(scanLockKey(mode)); } catch {} }

// ========== cooldown helpers ==========
function cooldownKey(mode, symbol) { return `moon:cooldown:${String(mode || "bull").toLowerCase()}:${up(symbol)}`; }
async function readRecentEntryCount(mode, lookbackMs = ENTRY_LOOKBACK_MS) {
  const key = `moon:entry:history:${mode}`;
  const now = Date.now();
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const filtered = arr.filter(ts => n(ts, 0) >= now - lookbackMs).slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, filtered, { ex: 60 * 60 * 24 * 3 });
  return filtered.length;
}
async function appendEntryHistory(mode) {
  const key = `moon:entry:history:${mode}`;
  const now = Date.now();
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  const next = [now, ...arr].slice(0, ENTRY_HISTORY_KEEP);
  await kv.set(key, next, { ex: 60 * 60 * 24 * 3 });
}
function parseExitReason(p) {
  const r = String(p?.exitReason || p?.reason || p?.closedReason || p?.closeReason || "").toLowerCase();
  if (r.includes("stop") || r.includes("sl")) return "sl";
  if (r.includes("tp") || r.includes("take")) return "tp";
  if (r.includes("timeout")) return "timeout";
  if (r.includes("early")) return "early";
  if (r.includes("thesis")) return "thesis";
  return "other";
}
function cooldownSecondsForExitReason(reasonKey) {
  if (reasonKey === "sl") return COOLDOWN_SL_SEC;
  if (reasonKey === "tp") return COOLDOWN_TP_SEC;
  if (reasonKey === "timeout") return COOLDOWN_TIMEOUT_SEC;
  if (reasonKey === "early") return COOLDOWN_EARLY_EXIT_SEC;
  if (reasonKey === "thesis") return COOLDOWN_EARLY_EXIT_SEC;
  return COOLDOWN_EARLY_EXIT_SEC;
}
async function applyCooldownsFromClosed(mode, positions, now) {
  const closed = Array.isArray(positions?.closed) ? positions.closed : [];
  const lookbackMs = 24 * 60 * 60 * 1000;
  for (const p of closed) {
    const sym = up(p?.symbol);
    if (!sym) continue;
    const closedAt = Number(p?.closedAt || p?.exitAt || p?.updatedAt || p?.ts || 0) || 0;
    if (closedAt <= 0 || closedAt < now - lookbackMs) continue;
    const reasonKey = parseExitReason(p);
    const cdSec = cooldownSecondsForExitReason(reasonKey);
    const until = closedAt + cdSec * 1000;
    if (until <= now) continue;
    const cdKey = cooldownKey(mode, sym);
    const prevUntil = Number((await kv.get(cdKey)) || 0);
    if (prevUntil >= until) continue;
    await kv.set(cdKey, until, { ex: cdSec });
  }
}

// ========== external data ==========
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(id); }
}
async function fetchExchangeFlows() {
  try {
    const data = await fetchJsonWithTimeout("https://api.binance.com/api/v3/ticker/24hr", {}, 8000);
    return data.filter(x => Number(x.quoteVolume) > 200_000_000).length;
  } catch { return 0; }
}
const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";
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
    const largestBidUsd = Math.max(...bids.slice(0, 8).map(b => n(b?.[1]) * n(b?.[0])), 0);
    const largestAskUsd = Math.max(...asks.slice(0, 8).map(b => n(b?.[1]) * n(b?.[0])), 0);
    const lor = total > 0 ? Math.max(largestBidUsd, largestAskUsd) / total : 0;
    return { bestBid, bestAsk, spreadPct, depthBidUsd, depthAskUsd, depthMinUsd1p: Math.min(depthBidUsd, depthAskUsd), score, lor, valid: true, fresh: true, stale: false, reason: "", status: "ok" };
  } catch { return null; }
}
function computeObScore(ob) {
  if (!ob) return { bestBid:0, bestAsk:0, spreadPct:999, depthBidUsd:0, depthAskUsd:0, depthMinUsd1p:0, score:0, lor:1, valid:false, fresh:false, stale:true, reason:"missing_snapshot", status:"none" };
  return { ...ob, valid:!!ob.valid, fresh:!!ob.fresh, stale:!!ob.stale };
}

// ========== universe builder ==========
async function buildUniverse({ CORE, mode, whaleFlow, btc, now }) {
  const regime = CORE.computeMarketRegime({ btc, whaleFlow, mode });
  // FIX: CoinGecko kan object {coins, meta} teruggeven
  const cg = await fetchCoinGeckoTopCached();
  const rawCoins = Array.isArray(cg?.coins) ? cg.coins : Array.isArray(cg) ? cg : [];
  const bitgetSymbols = await getBitgetSpotUsdtSymbols();
  const step1 = rawCoins.filter(c => !isBlockedMoonAsset(c));
  const step2 = step1.filter(c => bitgetSymbols.has(up(c.symbol)));
  const filtered = step2.slice(0, 180);
  const out = [];
  const state = (await kv.get(keyMoonState(mode))) || {};

  for (const coin of filtered) {
    const sym = up(coin.symbol);
    const prev = state?.[sym] || {};
    let ob = null;
    if (n(coin.volume, 0) >= 250_000) ob = await fetchOrderbook(`${sym}USDT`);
    const obx = computeObScore(ob);
    const tier = getTierForMcap(coin.marketCap);
    const floorUsd = depthFloorUsd(coin.marketCap, tier, prev?.depthHist);
    const depthOk = n(obx.depthMinUsd1p, 0) >= floorUsd;

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

    const stageDecision = CORE.decideMoonStage({
      CORE, mode, coin, obx, priceHist: priceHistNext, volHist: volHistNext,
      btc, prev: { ...prev, volAcc }, whaleFlow, regime
    });
    const { stage, stageWhy, eliteType, moveScore, velocity, compression, breakout, persistenceScore, entryQuality } = stageDecision;
    const probs = CORE.computeMoonProbabilities({ mode, coin: { ...coin, ob: obx }, moveScore, velocity, compression, persistenceScore });
    const tradePlan = CORE.buildMoonTradePlan({ CORE, price: coin.price, mode, confidence: entryQuality || moveScore, range24: coin.range24, depthOk, tier, regime, persistenceScore });
    const qualityScore = CORE.computeQualityScore({ coin, moveScore, entryQuality, persistenceScore, velocity, compression, breakout });
    const liquidityScore = CORE.computeLiquidityScore({ ob: obx, depthOk, spreadPct: obx.spreadPct, depthMinUsd1p: obx.depthMinUsd1p });
    const timingScore = CORE.computeTimingScore({ mode, stage, breakout, volAcc, strongScans: prev?.strongScans || 0, eliteScans: prev?.eliteScans || 0, lateEntry: mode==="bull"? CORE.isLateBullEntry(coin): CORE.isLateBearEntry(coin), exhausted: mode==="bull"? CORE.isBullExhausted(coin): false, bounceTrap: mode==="bear"? CORE.isBearBounceTrap(coin): false });
    const marketScore = CORE.computeMarketScore({ btc, mode, regime, whaleFlow });
    const btcAlignmentScore = CORE.computeBtcAlignmentScore({ btc, mode, regime });
    const perfectCandidateScore = CORE.computePerfectCandidateScore({ qualityScore, liquidityScore, timingScore, marketScore });
    const { engineGate, uiGate, deskMeta } = CORE.computeDeskGate({
      mode, stage, entryQuality, persistenceScore, breakout, obScore: obx.score,
      tradePlan: !!tradePlan, now, prevGate: prev?.engineGate, prevMeta: prev?.deskMeta,
      isEliteStageForDesk: ["ELITE_IGNITION","ELITE_EXPANSION","ELITE_CASCADE"].includes(stage)
    });
    const uiLockUntil = Math.max(n(prev?.uiLockUntil,0), engineGate==="OPEN" ? now+UI_ENTRY_LOCK_MS_MOON : 0);

    const coinForOutput = {
      ...coin, side: sideFromMode(mode), stage, stageWhy, eliteType, moveScore,
      confidence: entryQuality || moveScore,
      moonProbability: probs?.moonProbability ?? 0,
      dumpProbability: probs?.dumpProbability ?? 0,
      tradeCandidate: engineGate === "OPEN", superScannerCoin: engineGate === "OPEN",
      qualityScore, liquidityScore, timingScore, marketScore, btcAlignmentScore, perfectCandidateScore,
      ob: { bestBid: obx.bestBid, bestAsk: obx.bestAsk, spreadPct: obx.spreadPct, depthBidUsd: obx.depthBidUsd, depthAskUsd: obx.depthAskUsd, score: obx.score, depthMinUsd1p: obx.depthMinUsd1p, valid: obx.valid, lor: obx.lor },
      thresholds: { depthFloorUsd: floorUsd, depthOk },
      breakout: { ready: breakout.ready, breakoutPct: breakout.breakoutPct, pressure: breakout.pressure },
      compression: { isCompressed: compression.isCompressed, flatPct: compression.flatPct },
      volAcc: { short: volAcc.short, medium: volAcc.medium },
      velocity, entryQuality, persistenceScore, tradePlan, range24: coin.range24,
      engineGate, tradeDeskStatus: uiGate, deskGate: uiGate, deskMeta, uiLockUntil,
      _state: { priceHist: priceHistNext, volHist: volHistNext, stageHist: (prev?.stageHist||[]).concat([stage]).slice(-12), volAcc }
    };

    const coinProfile = buildCoinProfile({ systemType: "moon", coin: coinForOutput });
    const execution = buildMoonExecutionDecision({
      coin: coinForOutput, btc, regime, mode, coinProfile,
      positionState: prev?.positionState || { inPosition: false, cyclesInTrade: 0, minHoldCycles: 6, weakHoldCount: 0, maxWeakHoldCycles: 3 },
      scannerGate: engineGate,
    });
    coinForOutput.coinProfile = coinProfile;
    coinForOutput.execution = execution;

    out.push(coinForOutput);
    await sleep(8);
  }
  return { regime, coins: out };
}

function shouldSendUpgradeSignal(oldStage, newStage) {
  if (oldStage === newStage) return false;
  const order = ["RADAR","BUILDUP","ALMOST","ELITE_IGNITION","ELITE_EXPANSION","ELITE_CASCADE"];
  const oldIdx = order.indexOf(oldStage);
  const newIdx = order.indexOf(newStage);
  return newIdx > oldIdx;
}

export default async function handler(req, res) {
  let mode = "bull";
  let lockAcquired = false;
  try {
    if (!requireSecret(req, res)) return;
    mode = String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";
    const mod = mode === "bear" ? await import("../../lib/_moon_core_bear.js") : await import("../../lib/_moon_core_bull.js");
    const CORE = mod?.default && typeof mod.default === "object" ? mod.default : mod;

    const lock = await acquireScanLock(mode);
    if (!lock.ok) {
      const latest = await kv.get(keyMoonLatest(mode));
      res.status(200).json(latest || { ok: true, skipped: true, reason: "scan_lock_active", mode });
      return;
    }
    lockAcquired = true;
    const now = Date.now();

    const whaleFlow = await fetchExchangeFlows();
    const btc = await fetchBTCGateFromUniverse();
    const prevPositions = (await kv.get(keyMoonPositions(mode))) || { open: [], closed: [] };
    const positions = { open: [...(prevPositions.open||[])], closed: [...(prevPositions.closed||[])] };
    await applyCooldownsFromClosed(mode, positions, now);

    const { regime, coins: universe } = await buildUniverse({ CORE, mode, whaleFlow, btc, now });
    const prevState = (await kv.get(keyMoonState(mode))) || {};
    const nextState = {};
    const universeMap = new Map(universe.map(c => [c.symbol, c]));
    let openMap = new Map(positions.open.map(p => [up(p.symbol), p]));

    // -------------------------------
    // 1. Update state voor ALLE coins (ook open posities, maar skip entry/upgrade voor open)
    // -------------------------------
    for (const coin of universe) {
      const sym = up(coin.symbol);
      const prev = prevState?.[sym] || {};
      const hasOpen = openMap.has(sym);

      const rawStage = coin.stage;
      const oldStage = prev.stage || "RADAR";

      // upgrade signal alleen als niet open
      if (!hasOpen && shouldSendUpgradeSignal(oldStage, rawStage)) {
        await safeSendSignal({
          source: "moon", action: "STAGE_UPGRADE", symbol: sym, price: coin.price,
          stage: rawStage, oldStage, mode, coin: coinForDiscord({ coin }),
          btcState: btc?.state || "NEUTRAL", kind: "upgrade",
          reason: `Stage upgrade: ${oldStage} → ${rawStage}`
        });
      }

      let strongScans = rawStage !== "RADAR" ? (prev.strongScans||0)+1 : 0;
      let weakScans = rawStage === "RADAR" ? (prev.weakScans||0)+1 : 0;
      let eliteScans = (rawStage.includes("ELITE") ? (prev.eliteScans||0)+1 : 0);
      let watchScans = coin.engineGate === "WATCH" ? (prev.watchScans||0)+1 : Math.max(0,(prev.watchScans||0)-1);
      let candidateSince = prev.candidateSince;
      if (rawStage !== "RADAR" && !candidateSince) candidateSince = now;
      let eliteSince = rawStage.includes("ELITE") ? (prev.eliteSince || now) : null;

      let entryLocked = prev.entryLocked || false;
      let entryReady = !hasOpen && coin.execution?.action === "ALLOW_ENTRY" && !entryLocked && coin.tradePlan != null;
      let uiLockUntil = Math.max(coin.uiLockUntil, n(prev.uiLockUntil,0));

      const depthHist = [...(prev.depthHist||[]), coin.ob?.depthMinUsd1p].filter(v=>v>0).slice(-20);
      const thesisDamage = CORE.computeThesisDamage(coin, prev, mode);

      nextState[sym] = {
        ...prev, stage: rawStage, stageWhy: coin.stageWhy, eliteType: coin.eliteType,
        price: coin.price, marketCap: coin.marketCap, volume: coin.volume,
        change24: coin.change24, change1h: coin.change1h, vm: coin.vm,
        confidence: coin.moveScore, entryQuality: coin.entryQuality, persistenceScore: coin.persistenceScore,
        moveScore: coin.moveScore, velocity: coin.velocity, moonProbability: coin.moonProbability,
        ob: coin.ob, thresholds: coin.thresholds, compression: coin.compression, breakout: coin.breakout,
        volAcc: coin.volAcc, tradePlan: coin.tradePlan,
        thesisDamage: thesisDamage.damage, thesisReasons: thesisDamage.reasons,
        priceHist: coin._state.priceHist, volHist: coin._state.volHist, stageHist: coin._state.stageHist, depthHist,
        strongScans, weakScans, eliteScans, candidateSince, eliteSince, entryLocked, entryReady,
        lastSeen: now, qualityScore: coin.qualityScore, liquidityScore: coin.liquidityScore,
        timingScore: coin.timingScore, marketScore: coin.marketScore, btcAlignmentScore: coin.btcAlignmentScore,
        perfectCandidateScore: coin.perfectCandidateScore, superScannerCoin: !!coin.superScannerCoin,
        tradeCandidate: !!coin.tradeCandidate, scannerOnly: !coin.superScannerCoin,
        tradeDeskStatus: coin.tradeDeskStatus, engineGate: coin.engineGate, deskGate: coin.deskGate,
        deskMeta: coin.deskMeta, uiLockUntil, watchScans,
        positionState: prev.positionState || { inPosition: false, cyclesInTrade:0, minHoldCycles:6, weakHoldCount:0, maxWeakHoldCycles:3 },
        execution: coin.execution, coinProfile: coin.coinProfile,
      };
    }

    // -------------------------------
    // 2. Evaluate open positions (exit / hold) en update state voor open coins
    // -------------------------------
    const stillOpen = [];
    for (const pos of positions.open) {
      const sym = up(pos.symbol);
      const liveCoin = universeMap.get(sym);
      if (!liveCoin) {
        stillOpen.push(pos);
        continue;
      }

      const coinProfile = buildCoinProfile({ systemType: "moon", coin: liveCoin });
      const evalCoin = {
        ...liveCoin,
        entryPrice: pos.entryPrice,
        tradePlan: liveCoin.tradePlan || {
          entry: pos.entryPrice,
          sl: pos.sl,
          tp: pos.tp,
          rr: pos.rr,
          tpPct: pos.tpPct,
          slPct: pos.slPct,
        },
      };
      const execution = buildMoonExecutionDecision({
        coin: evalCoin, btc, regime, mode, coinProfile,
        positionState: {
          ...(nextState[sym]?.positionState || {}),
          inPosition: true,
          cyclesInTrade: n(pos.cyclesInTrade, 0) + 1,
        },
        scannerGate: liveCoin.engineGate || liveCoin.tradeDeskStatus,
      });

      if (execution.action === "EXIT") {
        const closedPos = {
          ...pos,
          closedAt: now,
          exitPrice: liveCoin.price,
          pnlPct: execution.meta?.pnlPct ?? 0,
          pnlUsd: (execution.meta?.pnlPct ?? 0) / 100 * POSITION_SIZE_USD,
          exitReason: execution.meta?.exitReason || execution.meta?.reason,
        };
        positions.closed.push(closedPos);
        await safePushEvent("trade_closed", { id: pos.id, mode, symbol: sym, exitPrice: liveCoin.price, pnlPct: closedPos.pnlPct, reason: closedPos.exitReason });
        await safeSendSignal({ source: "moon", action: "TRADE_CLOSED", symbol: sym, price: liveCoin.price, side: pos.side, mode, coin: coinForDiscord({ coin: liveCoin, position: pos }), position: closedPos, btcState: btc?.state || "NEUTRAL", kind: "trade_closed", pnl: closedPos.pnlPct, reason: closedPos.exitReason });
        if (nextState[sym]) {
          nextState[sym].positionState = { ...nextState[sym].positionState, inPosition: false, cyclesInTrade: 0 };
        }
      } else {
        const updatedPos = {
          ...pos,
          lastPrice: liveCoin.price,
          pnlPct: execution.meta?.pnlPct ?? pos.pnlPct ?? 0,
          execution,
          cyclesInTrade: n(pos.cyclesInTrade, 0) + 1,
        };
        stillOpen.push(updatedPos);
        if (nextState[sym]) {
          nextState[sym].positionState = {
            inPosition: true,
            cyclesInTrade: n(pos.cyclesInTrade, 0) + 1,
            minHoldCycles: 6,
            weakHoldCount: execution.action === "WEAK_HOLD" ? n(nextState[sym]?.positionState?.weakHoldCount, 0) + 1 : 0,
            maxWeakHoldCycles: 3,
          };
        }
      }
    }
    positions.open = stillOpen;
    // Refresh openMap after exit processing
    const refreshedOpenMap = new Map(positions.open.map(p => [up(p.symbol), p]));

    // -------------------------------
    // 3. Nieuwe entries openen (gebruik refreshedOpenMap)
    // -------------------------------
    const entryCandidates = [];
    for (const sym of Object.keys(nextState)) {
      const state = nextState[sym];
      if (state.entryReady && state.tradeCandidate && !refreshedOpenMap.has(sym)) {
        const cdKey = cooldownKey(mode, sym);
        const cdUntil = await kv.get(cdKey);
        if (n(cdUntil,0) <= now) entryCandidates.push({ sym, state, coin: universeMap.get(sym) });
      }
    }
    entryCandidates.sort((a,b)=> (b.coin?.entryQuality||0) - (a.coin?.entryQuality||0));
    const slotsLeft = MAX_OPEN_TRADES - positions.open.length;
    const toOpen = entryCandidates.slice(0, Math.min(slotsLeft, 1));
    for (const cand of toOpen) {
      const { sym, coin, state } = cand;
      const id = uid("moon");
      const newPos = {
        id, symbol: sym, mode, side: sideFromMode(mode), status: "OPEN", entryAt: now,
        entryPrice: coin.tradePlan.entry, lastPrice: coin.price, sizeUsd: POSITION_SIZE_USD,
        pnlPct:0, pnlUsd:0, tp: coin.tradePlan.tp, sl: coin.tradePlan.sl, rr: coin.tradePlan.rr,
        tpPct: coin.tradePlan.tpPct, slPct: coin.tradePlan.slPct, entryQuality: coin.entryQuality,
        persistenceScore: coin.persistenceScore, regime, stage: coin.stage, eliteType: coin.eliteType
      };
      positions.open.push(newPos);
      nextState[sym] = { ...state, entryActive: true, entryLocked: true, entryReady: false, lastEntryAt: now, uiLockUntil: Math.max(state.uiLockUntil, now+UI_ENTRY_LOCK_MS_MOON), positionState: { inPosition: true, cyclesInTrade:0, minHoldCycles:6, weakHoldCount:0, maxWeakHoldCycles:3 } };
      await appendEntryHistory(mode);
      await safePushEvent("trade_opened", { id, mode, side: newPos.side, symbol: sym, entry: newPos.entryPrice, size: newPos.sizeUsd, tp: newPos.tp, sl: newPos.sl, rr: newPos.rr, stage: newPos.stage, eliteType: newPos.eliteType });
      await safeSendSignal({ source: "moon", action: "OPEN_TRADE", symbol: sym, price: newPos.entryPrice, side: newPos.side, stage: coin.stage, mode, coin: coinForDiscord({ coin, position: newPos }), position: newPos, btcState: btc?.state || "NEUTRAL", kind: "trade_opened", reason: "Nieuwe positie geopend door Moon engine" });
    }

    // -------------------------------
    // 4. Funnel splitsen (gebruik refreshedOpenMap)
    // -------------------------------
    const funnel = CORE.splitFunnels(universe);
    const holdItems = [];
    for (const p of positions.open) {
      const coin = universeMap.get(up(p.symbol));
      holdItems.push({ symbol: p.symbol, kind: "IN_TRADE", reason: "open_position", entryAt: p.entryAt, entryPrice: p.entryPrice, lastPrice: p.lastPrice, pnlPct: p.pnlPct, pnlUsd: p.pnlUsd, coin, state: nextState[up(p.symbol)] });
    }
    for (const sym of Object.keys(nextState)) {
      if (!refreshedOpenMap.has(sym) && n(nextState[sym]?.uiLockUntil,0) > now) {
        holdItems.push({ symbol: sym, kind: "ENTRY_LOCK", reason: "entry_signal_lock", lockUntil: nextState[sym].uiLockUntil, coin: universeMap.get(sym), state: nextState[sym] });
      }
    }
    funnel.hold = holdItems;

    // -------------------------------
    // 5. Portfolio & opslag
    // -------------------------------
    const portfolio = {
      mode, posUsd: POSITION_SIZE_USD, openCount: positions.open.length, closedCount: positions.closed.length,
      realizedUsd: positions.closed.reduce((a,b)=>a+n(b.pnlUsd),0),
      avgRealizedPct: positions.closed.length ? positions.closed.reduce((a,b)=>a+n(b.pnlPct),0)/positions.closed.length : 0,
      updatedAt: now
    };
    await kv.set(keyMoonPortfolio(mode), portfolio, { ex: 60*60*24*7 });
    positions.closed = positions.closed.slice(-1000);
    await kv.set(keyMoonState(mode), nextState, { ex: 60*60*24*3 });
    await kv.set(keyMoonPositions(mode), positions, { ex: 60*60*24*7 });

    // -------------------------------
    // 6. Response
    // -------------------------------
    const premiumCandidates = universe.filter(c=>c.superScannerCoin).sort((a,b)=>b.perfectCandidateScore-a.perfectCandidateScore).slice(0,12);
    const tradeReady = universe.filter(c=>c.tradeDeskStatus==="OPEN").sort((a,b)=>b.perfectCandidateScore-a.perfectCandidateScore).slice(0,20);
    const watchCandidates = universe.filter(c=>c.tradeDeskStatus==="WATCH").sort((a,b)=>b.perfectCandidateScore-a.perfectCandidateScore).slice(0,20);
    const scannerOnly = universe.filter(c=>!c.superScannerCoin).sort((a,b)=>b.perfectCandidateScore-a.perfectCandidateScore).slice(0,20);
    const latest = {
      ok: true, mode, regime, btc: { price: btc.price, chg24: btc.chg24, chg1h: btc.chg1h, range24: btc.range24, state: btc.state },
      whaleFlow, funnel, counts: { elite_expansion: funnel.elite_expansion?.length||0, elite_ignition: funnel.elite_ignition?.length||0, almost: funnel.almost?.length||0, buildup: funnel.buildup?.length||0, radar: funnel.radar?.length||0, hold: funnel.hold?.length||0 },
      candidates: { premium: premiumCandidates, tradeReady, watch: watchCandidates, scannerOnly },
      portfolio, positions: { open: positions.open.length, closed: positions.closed.length, openItems: positions.open.map(p=>({ id:p.id, symbol:p.symbol, mode:p.mode, side:p.side, status:p.status, entryAt:p.entryAt, entryPrice:p.entryPrice, lastPrice:p.lastPrice, pnlPct:p.pnlPct, pnlUsd:p.pnlUsd, tp:p.tp, sl:p.sl, rr:p.rr, stage:p.stage, eliteType:p.eliteType })) },
      ts: now, scannedAt: now
    };
    await kv.set(keyMoonLatest(mode), latest, { ex: 60*60 });
    res.status(200).json(latest);
  } catch (err) {
    console.error("Moon scan error:", err);
    res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    if (lockAcquired) await releaseScanLock(mode);
  }
}