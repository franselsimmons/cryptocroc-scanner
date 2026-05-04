// lib/filterState.js

let filters = null;

const stages = ["radar", "buildup", "almost", "entry"];

const DEFAULT_FILTERS = Object.freeze({
  bull: {
    radar: {
      scoreMin: 26,
      volumeMin: 0.018,
      tfMin: 0,
      freshnessMin: 0,
      pressureMin: 0.00,
      accelerationMin: -0.80,
      allowNeutral: false
    },
    buildup: {
      scoreMin: 42,
      volumeMin: 0.025,
      tfMin: 0,
      freshnessMin: 4,
      pressureMin: 0.04,
      accelerationMin: -0.55,
      allowNeutral: false
    },
    almost: {
      scoreMin: 64,
      volumeMin: 0.035,
      tfMin: 0.6,
      freshnessMin: 7,
      pressureMin: 0.08,
      accelerationMin: -0.35,
      allowNeutral: false
    },
    entry: {
      scoreMin: 74,
      volumeMin: 0.045,
      tfMin: 1.0,
      freshnessMin: 10,
      pressureMin: 0.12,
      accelerationMin: -0.25,
      allowNeutral: false
    }
  },

  bear: {
    radar: {
      scoreMin: 26,
      volumeMin: 0.018,
      tfMin: 0,
      freshnessMin: 0,
      pressureMin: 0.00,
      accelerationMin: -0.80,
      allowNeutral: false
    },
    buildup: {
      scoreMin: 42,
      volumeMin: 0.025,
      tfMin: 0,
      freshnessMin: 4,
      pressureMin: 0.04,
      accelerationMin: -0.55,
      allowNeutral: false
    },
    almost: {
      scoreMin: 64,
      volumeMin: 0.035,
      tfMin: 0.6,
      freshnessMin: 7,
      pressureMin: 0.08,
      accelerationMin: -0.35,
      allowNeutral: false
    },
    entry: {
      scoreMin: 74,
      volumeMin: 0.045,
      tfMin: 1.0,
      freshnessMin: 10,
      pressureMin: 0.12,
      accelerationMin: -0.25,
      allowNeutral: false
    }
  },

  trade: {
    rrMin: 1.20,
    scoreMin: 70,
    confluenceMin: 68,
    freshnessMin: 6,
    pressureMin: 0.10,
    accelerationMin: -0.35,

    allowAlmostEntry: false,
    requireRunnerFlow: true,
    requireHotFlow: true,

    blockSpoof: true,
    blockFakeBreakoutTrap: true,

    maxSpreadPct: 0.14,
    minDepthUsd1p: 50_000,

    partialTpR: 1.0,
    moveToBreakevenR: 1.0,
    trailStartR: 1.6,
    trailAtrMultiplier: 1.25,

    maxAdds: 1
  }
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === undefined || value === null) return fallback;

  const s = String(value).toLowerCase();

  if (["true", "1", "yes", "on"].includes(s)) return true;
  if (["false", "0", "no", "off"].includes(s)) return false;

  return fallback;
}

function normalizeStage(stageConfig = {}, fallback = {}) {
  return {
    scoreMin: toNumber(stageConfig.scoreMin, fallback.scoreMin ?? 0),
    volumeMin: toNumber(stageConfig.volumeMin, fallback.volumeMin ?? 0),
    tfMin: toNumber(stageConfig.tfMin, fallback.tfMin ?? 0),

    freshnessMin: toNumber(stageConfig.freshnessMin, fallback.freshnessMin ?? 0),
    pressureMin: toNumber(stageConfig.pressureMin, fallback.pressureMin ?? 0),
    accelerationMin: toNumber(stageConfig.accelerationMin, fallback.accelerationMin ?? -999),

    allowNeutral: toBool(stageConfig.allowNeutral, fallback.allowNeutral ?? false)
  };
}

function normalizeTrade(tradeConfig = {}, fallback = DEFAULT_FILTERS.trade) {
  return {
    rrMin: toNumber(tradeConfig.rrMin, fallback.rrMin),
    scoreMin: toNumber(tradeConfig.scoreMin, fallback.scoreMin),
    confluenceMin: toNumber(tradeConfig.confluenceMin, fallback.confluenceMin),
    freshnessMin: toNumber(tradeConfig.freshnessMin, fallback.freshnessMin),
    pressureMin: toNumber(tradeConfig.pressureMin, fallback.pressureMin),
    accelerationMin: toNumber(tradeConfig.accelerationMin, fallback.accelerationMin),

    allowAlmostEntry: toBool(tradeConfig.allowAlmostEntry, fallback.allowAlmostEntry),
    requireRunnerFlow: toBool(tradeConfig.requireRunnerFlow, fallback.requireRunnerFlow),
    requireHotFlow: toBool(tradeConfig.requireHotFlow, fallback.requireHotFlow),

    blockSpoof: toBool(tradeConfig.blockSpoof, fallback.blockSpoof),
    blockFakeBreakoutTrap: toBool(tradeConfig.blockFakeBreakoutTrap, fallback.blockFakeBreakoutTrap),

    maxSpreadPct: toNumber(tradeConfig.maxSpreadPct, fallback.maxSpreadPct),
    minDepthUsd1p: toNumber(tradeConfig.minDepthUsd1p, fallback.minDepthUsd1p),

    partialTpR: toNumber(tradeConfig.partialTpR, fallback.partialTpR),
    moveToBreakevenR: toNumber(tradeConfig.moveToBreakevenR, fallback.moveToBreakevenR),
    trailStartR: toNumber(tradeConfig.trailStartR, fallback.trailStartR),
    trailAtrMultiplier: toNumber(tradeConfig.trailAtrMultiplier, fallback.trailAtrMultiplier),

    maxAdds: toNumber(tradeConfig.maxAdds, fallback.maxAdds)
  };
}

// ================= INIT DEFAULTS =================
export function initDefaultFilters(force = false) {
  if (!filters || force) {
    filters = clone(DEFAULT_FILTERS);
  }

  return filters;
}

// ================= GET =================
export function getFilters() {
  if (!filters) {
    initDefaultFilters();
  }

  return filters;
}

// ================= SET =================
export function setFilters(newFilters = {}) {
  const current = getFilters();

  for (const side of ["bull", "bear"]) {
    for (const stage of stages) {
      const incoming = newFilters?.[side]?.[stage];
      if (!incoming) continue;

      current[side][stage] = normalizeStage(
        {
          ...current[side][stage],
          ...incoming
        },
        DEFAULT_FILTERS[side][stage]
      );
    }
  }

  if (newFilters.trade) {
    current.trade = normalizeTrade(
      {
        ...current.trade,
        ...newFilters.trade
      },
      current.trade || DEFAULT_FILTERS.trade
    );
  }

  return current;
}

export function resetFilters() {
  filters = clone(DEFAULT_FILTERS);
  return filters;
}

export function getDefaultFilters() {
  return clone(DEFAULT_FILTERS);
}