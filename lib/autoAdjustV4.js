// lib/autoAdjustV4.js

import { getFilters, setFilters } from "./filterState.js";
import { getWinrate } from "./aiMemory.js";

const COOLDOWN_MS = 15 * 60 * 1000;
const STAGES = ["radar", "buildup", "almost", "entry"];
const SIDES = ["bull", "bear"];

let lastRun = 0;

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v)));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function normalizeMarketState(market) {
  if (typeof market === "string") {
    return market.toUpperCase();
  }

  const state = String(market?.state || market?.trend || market?.mode || "").toUpperCase();

  if (state.includes("TREND")) return "TRENDING";
  if (state.includes("CHOP")) return "CHOPPY";
  if (state.includes("HIGH_VOL")) return "HIGH_VOL";
  if (state.includes("LOW_VOL")) return "LOW_VOL";

  return state || "UNKNOWN";
}

function getAdjustmentList(advice, side, stage) {
  const structured = advice?._adjustments?.[side]?.[stage];

  if (Array.isArray(structured) && structured.length) {
    return structured;
  }

  const legacy = advice?.[side]?.[stage];

  if (!Array.isArray(legacy)) return [];

  return legacy
    .map(parseLegacyAdvice)
    .filter(Boolean);
}

function parseLegacyAdvice(item) {
  if (!item || typeof item !== "string") return null;

  const text = item.toLowerCase();

  const scoreMatch = item.match(/score\s+(\d+)/i);
  const score = scoreMatch ? Number(scoreMatch[1]) : null;

  if (text.includes("soepeler") && score) {
    return {
      type: "score",
      direction: "loosen",
      recommended: score,
      message: item
    };
  }

  if (text.includes("strenger") && score) {
    return {
      type: "score",
      direction: "tighten",
      recommended: score,
      message: item
    };
  }

  if (text.includes("volume") && text.includes("verhogen")) {
    return {
      type: "volume",
      direction: "tighten",
      recommended: null,
      message: item
    };
  }

  if (text.includes("neutral") && text.includes("toestaan")) {
    return {
      type: "flow",
      direction: "loosen",
      recommended: "ALLOW",
      message: item
    };
  }

  return null;
}

function ensureFilterStage(updated, side, stage) {
  if (!updated[side]) updated[side] = {};
  if (!updated[side][stage]) {
    updated[side][stage] = {
      scoreMin: 65,
      volumeMin: 0.025,
      allowNeutral: false
    };
  }

  return updated[side][stage];
}

function applyAdviceAdjustment(f, adjustment) {
  if (!adjustment) return;

  if (adjustment.type === "score") {
    const recommended = safeNumber(adjustment.recommended, f.scoreMin);

    f.scoreMin = clamp(recommended, 35, 95);
    return;
  }

  if (adjustment.type === "volume") {
    const recommended = Number.isFinite(Number(adjustment.recommended))
      ? Number(adjustment.recommended)
      : f.volumeMin + 0.01;

    f.volumeMin = clamp(recommended, 0.01, 0.75);
    return;
  }

  if (adjustment.type === "flow") {
    f.allowNeutral = adjustment.recommended === "ALLOW";
    return;
  }

  if (adjustment.type === "pressure") {
    f.scoreMin = clamp(f.scoreMin + 2, 35, 95);
    return;
  }

  if (adjustment.type === "freshness") {
    f.scoreMin = clamp(f.scoreMin + 2, 35, 95);
    return;
  }

  if (adjustment.type === "acceleration") {
    f.scoreMin = clamp(f.scoreMin + 3, 35, 95);
  }
}

function applyMarketAdjustment(f, marketState) {
  if (marketState === "TRENDING") {
    f.scoreMin -= 3;
    f.volumeMin -= 0.005;
  }

  if (marketState === "LOW_VOL") {
    f.scoreMin -= 2;
    f.volumeMin -= 0.005;
  }

  if (marketState === "HIGH_VOL") {
    f.scoreMin += 3;
    f.volumeMin += 0.005;
  }

  if (marketState === "CHOPPY") {
    f.scoreMin += 5;
    f.volumeMin += 0.01;
    f.allowNeutral = false;
  }
}

function applyWinrateAdjustment(f, winrate) {
  if (winrate < 40) {
    f.scoreMin += 5;
    f.volumeMin += 0.005;
    f.allowNeutral = false;
  }

  if (winrate > 65) {
    f.scoreMin -= 3;
  }
}

function finalizeFilter(f) {
  f.scoreMin = clamp(f.scoreMin, 35, 95);
  f.volumeMin = clamp(f.volumeMin, 0.01, 0.75);
  f.allowNeutral = Boolean(f.allowNeutral);
}

export function autoAdjustV4(advice, market) {
  const now = Date.now();

  if (now - lastRun < COOLDOWN_MS) {
    return {
      skipped: true,
      reason: "cooldown",
      nextRunAt: lastRun + COOLDOWN_MS,
      profile: "RUNNER"
    };
  }

  const filters = getFilters();
  const updated = clone(filters);
  const marketState = normalizeMarketState(market);

  const applied = [];

  for (const side of SIDES) {
    const winrate = getWinrate(side);

    for (const stage of STAGES) {
      const f = ensureFilterStage(updated, side, stage);
      const adjustments = getAdjustmentList(advice, side, stage);

      for (const adjustment of adjustments) {
        applyAdviceAdjustment(f, adjustment);

        applied.push({
          side,
          stage,
          type: adjustment.type,
          direction: adjustment.direction || "auto",
          recommended: adjustment.recommended ?? null,
          message: adjustment.message || null
        });
      }

      applyMarketAdjustment(f, marketState);
      applyWinrateAdjustment(f, winrate);
      finalizeFilter(f);
    }
  }

  setFilters(updated);
  lastRun = now;

  return {
    success: true,
    profile: "RUNNER",
    market: marketState,
    appliedCount: applied.length,
    applied,
    winrates: {
      bull: getWinrate("bull"),
      bear: getWinrate("bear")
    },
    updatedAt: now
  };
}

export function resetAutoAdjustCooldown() {
  lastRun = 0;

  return {
    ok: true,
    profile: "RUNNER",
    lastRun
  };
}