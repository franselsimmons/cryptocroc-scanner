import { kv } from "@vercel/kv";

import {
  RUNTIME_CONFIG,
  requireSecret,
  keyMainLatest,
  keyMainPortfolio,
  keyMainPositions,
  keyMainState,
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,
  getTierForMcap,
  depthFloorUsd,
  computeMoonRisk,
  calcPnlPct,
  hitStopOrTp,
  isBlockedMoonAsset,
  MAIN_V2,
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
  isLateBullEntry,
  isLateBearEntry,
  computeMoonProbabilities,
  computeBtcAlignmentScore,
  computeQualityScore,
  computeLiquidityScore,
  computeTimingScore,
  computeMarketScore,
  computePerfectCandidateScore,
} from "../../../lib/_moon_core.js";

import { pushEvent, uid } from "../../../lib/_analytics.js";
import { sendSignal } from "../../../lib/discordRouter.js";
import {
  buildCoinProfile,
  buildMainExecutionDecision,
} from "../../../lib/_trade_engine.js";

export const config = RUNTIME_CONFIG;

/* ============================================================
   PERFECT BALANCE SCANNER TUNING
   ============================================================ */

const SCAN_THRESHOLDS = {
  superScanner: {
    perfect: 70,
    quality: 64,
  },
  tradeCandidate: {
    perfect: 71,
    quality: 63,
    timing: 60,
    liquidity: 56,
    market: 42,
  },
  watchNear: {
    entryQuality: 64,
    persistence: 52,
    breakoutPressure: 50,
  },
  watchStable: {
    entryQuality: 58,
    persistence: 48,
    breakoutPressure: 48,
  },
  watchHold: {
    entryQuality: 54,
    persistence: 45,
  },
};

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

/* ============================================================
   HANDLER
   ============================================================ */

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear"
        ? "bear"
        : "bull";

    const now = Date.now();

    const btc = await fetchBTCGateFromUniverse();
    const whaleFlow = 0;

    const regime = computeMarketRegime({ btc, whaleFlow, mode });

    const rawCoins = await fetchCoinGeckoTopCached();
    const bitgetSymbols = await getBitgetSpotUsdtSymbols();

    const coins = rawCoins
      .filter((c) => !isBlockedMoonAsset(c))
      .filter((c) => bitgetSymbols.has(up(c.symbol)))
      .slice(0, 120);

    const out = [];

    for (const coin of coins) {
      const velocity = computeVelocity(coin.change1h, coin.change24);
      const compression = computeCompression([]);
      const breakout = computeBreakoutPressure([]);

      const moveScore =
        mode === "bull"
          ? computeBullMoveScore(coin, {})
          : computeBearMoveScore(coin, {});

      const persistenceScore = computePersistenceScore({
        priceHist: [],
        volHist: [],
        stageHist: [],
        mode,
      });

      const entryQuality = computeEliteQuality({
        moveScore,
        velocity,
        vm: coin.vm,
        obScore: 0,
        compression,
        volAcc: { short: 1, medium: 1 },
        persistenceScore,
        regime,
        breakoutReady: breakout.ready,
      });

      const qualityScore = computeQualityScore({
        coin,
        moveScore,
        entryQuality,
        persistenceScore,
        velocity,
        compression,
        breakout,
      });

      const liquidityScore = computeLiquidityScore({
        ob: {},
        depthOk: true,
        spreadPct: 0.8,
        depthMinUsd1p: 25000,
      });

      const timingScore = computeTimingScore({
        mode,
        stage: "ALMOST",
        breakout,
        volAcc: { short: 1.05, medium: 1.1 },
        strongScans: 1,
        eliteScans: 1,
      });

      const marketScore = computeMarketScore({
        btc,
        mode,
        regime,
        whaleFlow,
      });

      const perfectCandidateScore = computePerfectCandidateScore({
        qualityScore,
        liquidityScore,
        timingScore,
        marketScore,
      });

      // ================= PERFECT BALANCE LOGIC =================

      const superScannerCoin =
        perfectCandidateScore >= SCAN_THRESHOLDS.superScanner.perfect &&
        qualityScore >= SCAN_THRESHOLDS.superScanner.quality;

      const tradeCandidate =
        perfectCandidateScore >= SCAN_THRESHOLDS.tradeCandidate.perfect &&
        qualityScore >= SCAN_THRESHOLDS.tradeCandidate.quality &&
        timingScore >= SCAN_THRESHOLDS.tradeCandidate.timing &&
        liquidityScore >= SCAN_THRESHOLDS.tradeCandidate.liquidity &&
        marketScore >= SCAN_THRESHOLDS.tradeCandidate.market;

      let tradeDeskStatus = "IGNORE";

      if (tradeCandidate) {
        tradeDeskStatus = "OPEN";
      } else if (
        superScannerCoin &&
        entryQuality >= SCAN_THRESHOLDS.watchNear.entryQuality &&
        persistenceScore >= SCAN_THRESHOLDS.watchNear.persistence &&
        (breakout.ready ||
          n(breakout.pressure, 0) >=
            SCAN_THRESHOLDS.watchNear.breakoutPressure)
      ) {
        tradeDeskStatus = "WATCH";
      }

      const coinProfile = buildCoinProfile({
        systemType: "main",
        coin,
      });

      const execution = buildMainExecutionDecision({
        coin: {
          ...coin,
          entryQuality,
          persistenceScore,
          tradeCandidate,
        },
        btc,
        regime,
        mode,
        coinProfile,
        positionState: { inPosition: false },
        scannerGate: tradeDeskStatus,
      });

      out.push({
        ...coin,
        entryQuality,
        persistenceScore,
        qualityScore,
        liquidityScore,
        timingScore,
        marketScore,
        perfectCandidateScore,
        superScannerCoin,
        tradeCandidate,
        tradeDeskStatus,
        execution,
      });
    }

    const latest = {
      ok: true,
      mode,
      regime,
      btc,
      coins: out,
      ts: now,
    };

    await kv.set(keyMainLatest(mode), latest, { ex: 60 * 60 });

    res.status(200).json(latest);
  } catch (err) {
    console.error("Main scan error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}