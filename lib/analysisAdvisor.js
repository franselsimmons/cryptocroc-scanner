// lib/analysisAdvisor.js

import { getFilters } from "./filterState.js";

const STAGES = ["radar", "buildup", "almost", "entry"];

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function getStageTotal(analytics, side, stage) {
  return safeNumber(analytics?.[side]?.[stage]?.total || 0);
}

function getReasonCount(analytics, side, stage, reason) {
  return safeNumber(analytics?.[side]?.[stage]?.reasonCounts?.[reason], 0);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, Number(v)));
}

function pushAdvice(advice, adjustments, side, stage, message, adjustment = null) {
  advice[side][stage].push(message);

  if (adjustment) {
    adjustments[side][stage].push({
      ...adjustment,
      side,
      stage,
      message
    });
  }
}

function createAdviceShell() {
  const advice = { bull: {}, bear: {} };
  const adjustments = { bull: {}, bear: {} };

  for (const side of ["bull", "bear"]) {
    for (const stage of STAGES) {
      advice[side][stage] = [];
      adjustments[side][stage] = [];
    }
  }

  return { advice, adjustments };
}

export function generateAdvice(analytics) {
  const filters = getFilters();
  const { advice, adjustments } = createAdviceShell();

  for (const side of ["bull", "bear"]) {
    for (let i = 0; i < STAGES.length; i++) {
      const stage = STAGES[i];
      const next = STAGES[i + 1];

      if (!next) {
        advice[side][stage] = ["Runner entry-stage is eindbucket. Geen auto-advies nodig."];
        continue;
      }

      const current = getStageTotal(analytics, side, stage);
      const nextCount = getStageTotal(analytics, side, next);

      if (current < 5) {
        advice[side][stage] = [
          "Te weinig echte runner filter-data voor betrouwbaar advies."
        ];
        continue;
      }

      const flowPct = current > 0
        ? (nextCount / current) * 100
        : 0;

      const f = filters?.[side]?.[next] || {};
      const scoreMin = safeNumber(f.scoreMin, 65);
      const volumeMin = safeNumber(f.volumeMin, 0.025);

      const lowScoreCount = getReasonCount(analytics, side, stage, "lowScore");
      const weakPressureCount = getReasonCount(analytics, side, stage, "weakPressure");
      const lowFreshnessCount = getReasonCount(analytics, side, stage, "lowFreshness");
      const negativeAccelerationCount = getReasonCount(analytics, side, stage, "negativeAcceleration");
      const lowVolumeCount = getReasonCount(analytics, side, stage, "lowVolume");

      const weakPressurePct = (weakPressureCount / Math.max(current, 1)) * 100;
      const lowFreshnessPct = (lowFreshnessCount / Math.max(current, 1)) * 100;
      const negativeAccelerationPct = (negativeAccelerationCount / Math.max(current, 1)) * 100;
      const lowVolumePct = (lowVolumeCount / Math.max(current, 1)) * 100;
      const lowScorePct = (lowScoreCount / Math.max(current, 1)) * 100;

      if (flowPct < 8) {
        pushAdvice(
          advice,
          adjustments,
          side,
          stage,
          `${next} iets soepeler testen: score ${clamp(scoreMin - 4, 35, 95)}.`,
          {
            type: "score",
            direction: "loosen",
            recommended: clamp(scoreMin - 4, 35, 95)
          }
        );
      }

      if (flowPct > 38) {
        pushAdvice(
          advice,
          adjustments,
          side,
          stage,
          `${next} iets strenger zetten: score ${clamp(scoreMin + 4, 35, 95)}.`,
          {
            type: "score",
            direction: "tighten",
            recommended: clamp(scoreMin + 4, 35, 95)
          }
        );
      }

      if (lowVolumePct > 45) {
        pushAdvice(
          advice,
          adjustments,
          side,
          stage,
          `${stage} heeft veel low-volume runners. VolumeMin verhogen naar ${clamp(volumeMin + 0.01, 0.01, 0.75).toFixed(3)}.`,
          {
            type: "volume",
            direction: "tighten",
            recommended: clamp(volumeMin + 0.01, 0.01, 0.75)
          }
        );
      }

      if (weakPressurePct > 45) {
        pushAdvice(
          advice,
          adjustments,
          side,
          stage,
          `${stage} heeft zwakke directionele druk. Runner pressure strenger beoordelen.`,
          {
            type: "pressure",
            direction: "tighten",
            recommended: "TIGHTEN"
          }
        );
      }

      if (lowFreshnessPct > 40) {
        pushAdvice(
          advice,
          adjustments,
          side,
          stage,
          `${stage} bevat te veel oude moves. Freshness zwaarder wegen.`,
          {
            type: "freshness",
            direction: "tighten",
            recommended: "TIGHTEN"
          }
        );
      }

      if (negativeAccelerationPct > 30) {
        pushAdvice(
          advice,
          adjustments,
          side,
          stage,
          `${stage} heeft te vaak negatieve acceleration. Continuation-gate strakker zetten.`,
          {
            type: "acceleration",
            direction: "tighten",
            recommended: "TIGHTEN"
          }
        );
      }

      if (lowScorePct < 12 && flowPct < 20) {
        pushAdvice(
          advice,
          adjustments,
          side,
          stage,
          `${stage} score is gezond maar flow laag. Neutral flow tijdelijk toestaan voor test.`,
          {
            type: "flow",
            direction: "loosen",
            recommended: "ALLOW"
          }
        );
      }

      if (advice[side][stage].length === 0) {
        advice[side][stage].push("Runner flow is gezond. Geen specifieke aanpassing.");
      }
    }
  }

  return {
    ...advice,
    _adjustments: adjustments,
    profile: "RUNNER",
    generatedAt: Date.now()
  };
}