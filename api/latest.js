// api/latest.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG } from "../lib/_runtime.js";
import { buildCoinProfile, buildMainExecutionDecision } from "../lib/_trade_engine.js";

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

function keyMainLatest(mode) {
  return `main:latest:${String(mode || "bull").toLowerCase()}`;
}

// stage -> scanner gate voor engine
function gateFromStage(stage) {
  const st = up(stage);
  if (st === "ENTRY") return "OPEN";
  if (st === "ALMOST") return "WATCH";
  return "IGNORE";
}

function addExecutionToMainCoin({ coin, mode, btc, regime }) {
  const scannerGate = gateFromStage(coin?.stage);

  const tradeDeskStatus =
    scannerGate === "OPEN" ? "OPEN" : scannerGate === "WATCH" ? "WATCH" : "IGNORE";

  const side = mode === "bear" ? "SHORT" : "LONG";

  const coinForEngine = {
    ...coin,
    side,
    systemType: "main",
    tradeDeskStatus,
    scannerGate,
  };

  const coinProfile = buildCoinProfile({ systemType: "main", coin: coinForEngine });

  const positionState = {
    inPosition: false,
    cyclesInTrade: 0,
    minHoldCycles: 5,
    weakHoldCount: 0,
    maxWeakHoldCycles: 2,
    entryTicketActive: false,
    entryTicketSince: 0,
    now: Date.now(), // ✅ extra consistent
  };

  const execution = buildMainExecutionDecision({
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
    // ✅ voorkom caching issues
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const latest = (await kv.get(keyMainLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        regime: "TREND",
        btc: { state: "NEUTRAL", chg24: 0, chg1h: 0, range24: 0 },
        funnel: { entry: [], almost: [], buildup: [], radar: [] },
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
      });
    }

    const funnel = latest?.funnel || {};
    const entry0 = arr(funnel.entry);
    const almost0 = arr(funnel.almost);
    const buildup0 = arr(funnel.buildup);
    const radar0 = arr(funnel.radar);

    const ts = n(latest?.scannedAt, n(latest?.ts, 0));

    // BTC consistent shape
    const btcIn = latest?.btc || {};
    const btc = {
      price: n(btcIn.price, 0),
      chg24: n(btcIn.chg24, 0),
      chg1h: n(btcIn.chg1h, 0),
      range24: n(btcIn.range24, 0),
      state: String(btcIn.state || "NEUTRAL").toUpperCase(),
    };

    const regime = String(latest?.regime || "TREND").toUpperCase();

    const entry = entry0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));
    const almost = almost0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));
    const buildup = buildup0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));
    const radar = radar0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));

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
      error: e?.message || "latest_failed",
    });
  }
}