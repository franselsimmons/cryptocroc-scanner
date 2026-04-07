import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, keyMoonLatest } from "../../lib/_moon_core.js";
import { buildCoinProfile, buildMoonExecutionDecision } from "../../lib/_trade_engine.js";

export const config = RUNTIME_CONFIG;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function up(x) {
  return String(x || "").toUpperCase();
}

function gateFromStage(stage) {
  const st = up(stage);
  if (
    st === "ENTRY" ||
    st === "TRADE_READY" ||
    st === "ELITE_IGNITION" ||
    st === "ELITE_EXPANSION" ||
    st === "ELITE_CASCADE"
  ) {
    return "WATCH";
  }
  if (st === "ALMOST") return "WATCH";
  return "IGNORE";
}

function sideFromMode(mode) {
  return String(mode || "bull").toLowerCase() === "bear" ? "SHORT" : "LONG";
}

function addExecutionToMoonCoin({ coin, mode, btc, regime }) {
  const scannerGate = gateFromStage(coin?.stage);
  const tradeDeskStatus = scannerGate;
  const side = sideFromMode(mode);

  const coinForEngine = {
    ...coin,
    side,
    systemType: "moon",
    tradeDeskStatus,
    scannerGate,
  };

  const coinProfile = buildCoinProfile({
    systemType: "moon",
    coin: coinForEngine,
  });

  const positionState = {
    inPosition: false,
    cyclesInTrade: 0,
    minHoldCycles: 6,
    weakHoldCount: 0,
    maxWeakHoldCycles: 3,
    entryTicketActive: false,
    entryTicketSince: 0,
    now: Date.now(),
  };

  const execution = buildMoonExecutionDecision({
    coin: coinForEngine,
    btc,
    regime,
    mode,
    coinProfile,
    positionState,
    scannerGate,
  });

  return {
    ...coinForEngine,
    tradeDeskStatus,
    coinProfile,
    execution,
  };
}

export default async function handler(req, res) {
  try {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const latest = (await kv.get(keyMoonLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        regime: "TREND",
        btc: { state: "NEUTRAL", chg24: 0, chg1h: 0, range24: 0, price: 0 },
        whaleFlow: 0,
        funnel: { entry: [], almost: [], buildup: [], radar: [] },
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
        portfolio: {
          openCount: 0,
          closedCount: 0,
          realizedUsd: 0,
          avgRealizedPct: 0,
        },
        positions: { open: 0, closed: 0, openItems: [] },
      });
    }

    const funnel = latest?.funnel || {};
    const entry0 = arr(funnel.entry);
    const almost0 = arr(funnel.almost);
    const buildup0 = arr(funnel.buildup);
    const radar0 = arr(funnel.radar);

    const ts = n(latest?.scannedAt, n(latest?.ts, 0));

    const btcIn = latest?.btc || {};
    const btc = {
      price: n(btcIn.price, 0),
      chg24: n(btcIn.chg24, 0),
      chg1h: n(btcIn.chg1h, 0),
      range24: n(btcIn.range24, 0),
      state: String(btcIn.state || "NEUTRAL").toUpperCase(),
    };

    const regime = String(latest?.regime || "TREND").toUpperCase();

    const entry = entry0.map((c) =>
      addExecutionToMoonCoin({ coin: c, mode, btc, regime })
    );
    const almost = almost0.map((c) =>
      addExecutionToMoonCoin({ coin: c, mode, btc, regime })
    );
    const buildup = buildup0.map((c) =>
      addExecutionToMoonCoin({ coin: c, mode, btc, regime })
    );
    const radar = radar0.map((c) =>
      addExecutionToMoonCoin({ coin: c, mode, btc, regime })
    );

    return res.status(200).json({
      ...latest,
      ok: true,
      mode,
      ts,
      scannedAt: ts,
      btc,
      regime,
      funnel: { entry, almost, buildup, radar },
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
      },
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "moon_public_latest_failed",
    });
  }
}