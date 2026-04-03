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

  // coin krijgt tradeDeskStatus zodat profile/scannerGate consistent zijn
  const tradeDeskStatus =
    scannerGate === "OPEN" ? "OPEN" : scannerGate === "WATCH" ? "WATCH" : "IGNORE";

  // zorg dat side bestaat (engine forceert ook sideFromMode, maar profile gebruikt coin.side)
  const side = mode === "bear" ? "SHORT" : "LONG";

  const coinForEngine = {
    ...coin,
    side,
    systemType: "main",
    tradeDeskStatus,
    scannerGate,
  };

  const coinProfile = buildCoinProfile({ systemType: "main", coin: coinForEngine });

  // MAIN /api/latest heeft geen pos-admin, dus hier altijd “niet in positie”
  const positionState = {
    inPosition: false,
    cyclesInTrade: 0,
    minHoldCycles: 5,
    weakHoldCount: 0,
    maxWeakHoldCycles: 2,

    // ENTRY ticket defaults off (kan later door een manager gepersist worden)
    entryTicketActive: false,
    entryTicketSince: 0,
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
    const mode =
      String(req.query?.mode || "bull").toLowerCase() === "bear" ? "bear" : "bull";

    const latest = (await kv.get(keyMainLatest(mode))) || null;

    if (!latest) {
      return res.status(200).json({
        ok: true,
        mode,
        ts: 0,
        scannedAt: 0,
        btc: { state: "NEUTRAL", chg24: 0, range24: 0 },
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
    const btc = latest?.btc || { state: "NEUTRAL", chg24: 0, range24: 0 };

    // main heeft geen regime in scan payload; veilige default
    const regime = String(latest?.regime || "TREND").toUpperCase();

    // ✅ verrijk main coins met execution zodat Trade Desk ze kan tonen
    const entry = entry0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));
    const almost = almost0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));
    const buildup = buildup0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));
    const radar = radar0.map((c) => addExecutionToMainCoin({ coin: c, mode, btc, regime }));

    return res.status(200).json({
      ...latest,
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