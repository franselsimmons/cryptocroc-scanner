import { buildScanPayload } from "./scanner.js";

const SYSTEM_PROFILE = "RUNNER";

function normalizeSide(side) {
  const s = String(side || "").toLowerCase().trim();

  if (s === "bull") return "bull";
  if (s === "bear") return "bear";
  if (s === "both") return "both";

  return null;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function countStage(funnel, side, stage) {
  return safeArray(funnel?.[side]?.[stage]).length;
}

function countEntryCandidates(funnel) {
  return {
    bullEntry: countStage(funnel, "bull", "entry"),
    bearEntry: countStage(funnel, "bear", "entry"),
    bullAlmost: countStage(funnel, "bull", "almost"),
    bearAlmost: countStage(funnel, "bear", "almost")
  };
}

// ================= RUNNER SIDE FROM UTC MINUTE =================
// Bestaande side-slots blijven werken:
// 00 / 15 / 30 / 45 = bull
// 07 / 22 / 37 / 52 = bear
// Extra runner pulse:
// 03 / 18 / 33 / 48 = both
function inferSideFromMinute() {
  const minute = new Date().getUTCMinutes();

  if ([3, 18, 33, 48].includes(minute)) return "both";
  if ([0, 15, 30, 45].includes(minute)) return "bull";
  if ([7, 22, 37, 52].includes(minute)) return "bear";

  return "both";
}

function normalizeNotify(value, fallback = true) {
  if (value === undefined || value === null) return fallback;

  const v = String(value || "").toLowerCase().trim();

  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;

  return fallback;
}

function normalizeStore(value, fallback = true) {
  if (value === undefined || value === null) return fallback;

  const v = String(value || "").toLowerCase().trim();

  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;

  return fallback;
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const querySide = normalizeSide(req?.query?.side);
    const side = querySide || inferSideFromMinute();

    const notify = normalizeNotify(req?.query?.notify, true);
    const store = normalizeStore(req?.query?.store, true);

    const utcMinute = new Date().getUTCMinutes();

    console.log("RUNNER CRON START:", {
      profile: SYSTEM_PROFILE,
      side,
      querySide,
      notify,
      store,
      utcMinute,
      at: new Date().toISOString()
    });

    const data = await buildScanPayload({
      side,
      notify,
      store
    });

    const entryCounts = countEntryCandidates(data?.funnel);

    const trades = safeArray(data?.trades);
    const result = {
      ok: true,
      source: "cron",
      profile: SYSTEM_PROFILE,
      scannerProfile: data?.scannerProfile || SYSTEM_PROFILE,

      side,
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt,

      scanSide: data?.scanSide || side,
      scanMode: data?.scanMode || side,

      btc: data?.btc || null,
      regime: data?.regime || null,
      market: data?.market || null,

      funnelCount: data?.funnelCount || 0,
      bullCount: data?.bullCount || 0,
      bearCount: data?.bearCount || 0,

      candidates: data?.candidates || 0,
      candidatesBull: data?.candidatesBull || 0,
      candidatesBear: data?.candidatesBear || 0,

      ...entryCounts,

      trades: trades.length,
      bullTrades: trades.filter(t => t.side === "bull").length,
      bearTrades: trades.filter(t => t.side === "bear").length,

      bitgetSymbols: data?.bitgetSymbols || 0,
      bitgetUniverseReady: Boolean(data?.bitgetUniverseReady),

      lastBullScan: data?.lastBullScan || null,
      lastBearScan: data?.lastBearScan || null,
      scannerUpdatedAt: data?.scannerUpdatedAt || null,
      tradeFunnelUpdatedAt: data?.tradeFunnelUpdatedAt || null,
      updatedAt: data?.updatedAt || null
    };

    console.log("RUNNER CRON DONE:", result);

    return res.status(200).json(result);
  } catch (err) {
    console.error("RUNNER CRON ERROR:", err);

    return res.status(500).json({
      ok: false,
      source: "cron",
      profile: SYSTEM_PROFILE,
      error: err?.message || "runner_cron_failed",
      ranAt: Date.now(),
      durationMs: Date.now() - startedAt
    });
  }
}