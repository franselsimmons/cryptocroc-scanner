// ================= FILE: src/trade/positionSizing.js =================
//
// Long-only position sizing.
// Risk contribution = fraction of equity lost if position hits initial SL.
// Example: 0.0025 = 0.25% equity risk.

import { CONFIG } from '../config.js';
import {
  clamp,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_DIRECT = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY',
  'BID',
  'UP',
  'UPSIDE',
  'GREEN'
]);

const SHORT_DIRECT = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL',
  'ASK',
  'DOWN',
  'DOWNSIDE',
  'RED'
]);

function round6(value) {
  return Number(safeNumber(value, 0).toFixed(6));
}

function sizingConfig() {
  return {
    enabled: CONFIG.sizing?.enabled !== false,

    baseRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.baseRiskPct, 0.0025)
    ),

    minMult: Math.max(
      0,
      safeNumber(CONFIG.sizing?.minMult, 0.5)
    ),

    maxMult: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxMult, 1.25)
    ),

    maxTotalRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxTotalRiskPct, 0.03)
    ),

    maxSameSideRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxSameSideRiskPct, 0.015)
    ),

    maxCounterBtcRiskPct: Math.max(
      0,
      safeNumber(CONFIG.sizing?.maxCounterBtcRiskPct, 0.0075)
    ),

    priorTrades: Math.max(
      1,
      safeNumber(CONFIG.rotation?.priorTrades, 24)
    )
  };
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function cleanSideText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function normalizeTradeSide(value) {
  const raw = cleanSideText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (LONG_DIRECT.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_DIRECT.has(raw)) return OPPOSITE_TRADE_SIDE;

  const normalized = raw
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const longHit =
    normalized === 'LONG' ||
    normalized === 'BULL' ||
    normalized === 'BUY' ||
    normalized.includes('MICRO_LONG_') ||
    normalized.includes('TRADESIDE_LONG') ||
    normalized.includes('TRADE_SIDE_LONG') ||
    normalized.includes('POSITION_SIDE_LONG') ||
    normalized.includes('POSITIONSIDE_LONG') ||
    normalized.includes('SIDE_LONG') ||
    normalized.includes('SIDE_BULL') ||
    normalized.includes('DIRECTION_LONG') ||
    normalized.includes('DIRECTION_BULL') ||
    normalized.includes('SIDE_BUY') ||
    normalized.includes('DIRECTION_BUY') ||
    normalized.startsWith('LONG_') ||
    normalized.includes('_LONG_') ||
    normalized.endsWith('_LONG') ||
    normalized.startsWith('BULL_') ||
    normalized.includes('_BULL_') ||
    normalized.endsWith('_BULL') ||
    normalized.startsWith('BUY_') ||
    normalized.includes('_BUY_') ||
    normalized.endsWith('_BUY');

  const shortHit =
    normalized === 'SHORT' ||
    normalized === 'BEAR' ||
    normalized === 'SELL' ||
    normalized.includes('MICRO_SHORT_') ||
    normalized.includes('TRADESIDE_SHORT') ||
    normalized.includes('TRADE_SIDE_SHORT') ||
    normalized.includes('POSITION_SIDE_SHORT') ||
    normalized.includes('POSITIONSIDE_SHORT') ||
    normalized.includes('SIDE_SHORT') ||
    normalized.includes('SIDE_BEAR') ||
    normalized.includes('DIRECTION_SHORT') ||
    normalized.includes('DIRECTION_BEAR') ||
    normalized.includes('SIDE_SELL') ||
    normalized.includes('DIRECTION_SELL') ||
    normalized.startsWith('SHORT_') ||
    normalized.includes('_SHORT_') ||
    normalized.endsWith('_SHORT') ||
    normalized.startsWith('BEAR_') ||
    normalized.includes('_BEAR_') ||
    normalized.endsWith('_BEAR') ||
    normalized.startsWith('SELL_') ||
    normalized.includes('_SELL_') ||
    normalized.endsWith('_SELL');

  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;
  if (longHit && !shortHit) return TARGET_TRADE_SIDE;

  if (longHit && shortHit) {
    if (normalized.includes('TRADE_SIDE_LONG') || normalized.includes('TRADESIDE_LONG')) return TARGET_TRADE_SIDE;
    if (normalized.includes('TRADE_SIDE_SHORT') || normalized.includes('TRADESIDE_SHORT')) return OPPOSITE_TRADE_SIDE;
    if (normalized.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (normalized.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  if (longHit) return TARGET_TRADE_SIDE;
  if (shortHit) return OPPOSITE_TRADE_SIDE;

  return 'UNKNOWN';
}

function textParts(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,

    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : []),
    ...(Array.isArray(row.executionFingerprintParts) ? row.executionFingerprintParts : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean);
}

function idText(row = {}) {
  return [
    row.familyId,
    row.family,
    row.baseFamilyId,

    row.microFamilyId,
    row.trueMicroFamilyId,
    row.id,
    row.key,

    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.parentMicroFamilyId,
    row.parentFamilyId,
    row.macroId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasLongIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MICRO_LONG_') ||
    raw.includes('LONG_') ||
    raw.includes('_LONG_') ||
    raw.endsWith('_LONG') ||
    raw.includes('|LONG_') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG')
  );
}

function hasShortIdSignal(text = '') {
  const raw = upper(text);

  return (
    raw.includes('MICRO_SHORT_') ||
    raw.includes('SHORT_') ||
    raw.includes('_SHORT_') ||
    raw.endsWith('_SHORT') ||
    raw.includes('|SHORT_') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT')
  );
}

function hasLongDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=LONG') ||
    haystack.includes('TRADE_SIDE=LONG') ||
    haystack.includes('SIDE=LONG') ||
    haystack.includes('SIDE=BULL') ||
    haystack.includes('DIRECTION=LONG') ||
    haystack.includes('DIRECTION=BULL') ||
    haystack.includes('POSITION_SIDE=LONG') ||
    haystack.includes('POSITIONSIDE=LONG') ||
    haystack.includes('SIDE=BUY') ||
    haystack.includes('DIRECTION=BUY')
  );
}

function hasShortDefinitionSignal(parts = []) {
  const haystack = parts.join('|');

  return (
    haystack.includes('TRADESIDE=SHORT') ||
    haystack.includes('TRADE_SIDE=SHORT') ||
    haystack.includes('SIDE=SHORT') ||
    haystack.includes('SIDE=BEAR') ||
    haystack.includes('DIRECTION=SHORT') ||
    haystack.includes('DIRECTION=BEAR') ||
    haystack.includes('POSITION_SIDE=SHORT') ||
    haystack.includes('POSITIONSIDE=SHORT') ||
    haystack.includes('SIDE=SELL') ||
    haystack.includes('DIRECTION=SELL')
  );
}

function inferTradeSideFromIds(row = {}) {
  const haystack = idText(row);

  if (!haystack) return 'UNKNOWN';

  const longHit = hasLongIdSignal(haystack);
  const shortHit = hasShortIdSignal(haystack);

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSideFromDefinitions(row = {}) {
  const parts = textParts(row);

  if (!parts.length) return 'UNKNOWN';

  const longHit = hasLongDefinitionSignal(parts);
  const shortHit = hasShortDefinitionSignal(parts);
  const haystack = parts.join('|');

  if (longHit && !shortHit) return TARGET_TRADE_SIDE;
  if (shortHit && !longHit) return OPPOSITE_TRADE_SIDE;

  if (longHit && shortHit) {
    if (haystack.includes('TRADE_SIDE=LONG') || haystack.includes('TRADESIDE=LONG')) return TARGET_TRADE_SIDE;
    if (haystack.includes('TRADE_SIDE=SHORT') || haystack.includes('TRADESIDE=SHORT')) return OPPOSITE_TRADE_SIDE;
    if (haystack.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (haystack.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function inferTradeSide(row = {}) {
  if (typeof row !== 'object' || row === null) {
    return normalizeTradeSide(row);
  }

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.actualScannerSide,
    row.analysisSide,
    row.side
  ];

  for (const value of directSources) {
    const side = normalizeTradeSide(value);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const fromIds = inferTradeSideFromIds(row);

  if (fromIds === TARGET_TRADE_SIDE || fromIds === OPPOSITE_TRADE_SIDE) return fromIds;

  const fromDefinitions = inferTradeSideFromDefinitions(row);

  if (fromDefinitions === TARGET_TRADE_SIDE || fromDefinitions === OPPOSITE_TRADE_SIDE) {
    return fromDefinitions;
  }

  if (row.longOnly === true && row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || row.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizeBtcRelation(value) {
  const relation = upper(value, 'BTC_UNKNOWN');

  if (relation === 'BTC_WITH' || relation === 'WITH') return 'BTC_WITH';
  if (relation === 'BTC_AGAINST' || relation === 'AGAINST') return 'BTC_AGAINST';
  if (relation === 'BTC_NEUTRAL' || relation === 'NEUTRAL') return 'BTC_NEUTRAL';
  if (relation === 'BTC_UNKNOWN' || relation === 'UNKNOWN') return 'BTC_UNKNOWN';

  if (relation === 'BULLISH' || relation === 'STRONG_BULL') return 'BTC_WITH';
  if (relation === 'BEARISH' || relation === 'STRONG_BEAR') return 'BTC_AGAINST';

  return 'BTC_UNKNOWN';
}

function relationFromDefinitionParts(definitionParts = []) {
  const parts = Array.isArray(definitionParts) ? definitionParts : [];

  const directMatch = parts.find((part) => {
    const text = upper(part);

    return (
      text.startsWith('BTCRELATION=') ||
      text.startsWith('BTC_RELATION=') ||
      text.startsWith('BTC=') ||
      text.startsWith('BTC_STATE=')
    );
  });

  if (!directMatch) return 'BTC_UNKNOWN';

  return normalizeBtcRelation(String(directMatch).split('=').at(1));
}

function btcRelationFromRow(row = {}) {
  return normalizeBtcRelation(
    row.btcRelation ||
    row.btcStateRelation ||
    row.btcState ||
    relationFromDefinitionParts(row.definitionParts)
  );
}

function positionRiskFraction(position = {}) {
  const cfg = sizingConfig();
  const direct = safeNumber(position.riskFraction, NaN);

  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }

  return cfg.baseRiskPct;
}

function normalizeRiskFraction(value) {
  const cfg = sizingConfig();
  const risk = safeNumber(value, cfg.baseRiskPct);

  return clamp(
    risk,
    0,
    Math.max(
      cfg.maxTotalRiskPct,
      cfg.maxSameSideRiskPct,
      cfg.baseRiskPct,
      0
    )
  );
}

function buildStatsSideProbe({
  weeklyStats,
  side,
  tradeSide
} = {}) {
  return {
    ...(weeklyStats || {}),

    side: side ?? weeklyStats?.side,
    tradeSide: tradeSide ?? weeklyStats?.tradeSide,
    positionSide: tradeSide ?? weeklyStats?.positionSide,
    direction: tradeSide ?? weeklyStats?.direction
  };
}

function longModeFlags() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    virtualOnly: true,
    virtualLearning: true,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeOrdersDisabled: true
  };
}

export function riskFractionForEntry({
  weeklyStats,
  side = null,
  tradeSide = null
} = {}) {
  const cfg = sizingConfig();

  const explicitSideProvided =
    side !== null ||
    tradeSide !== null ||
    weeklyStats?.tradeSide ||
    weeklyStats?.side ||
    weeklyStats?.positionSide ||
    weeklyStats?.direction;

  const statsSide = inferTradeSide(
    buildStatsSideProbe({
      weeklyStats,
      side,
      tradeSide
    })
  );

  if (explicitSideProvided && statsSide !== TARGET_TRADE_SIDE) {
    return 0;
  }

  if (!cfg.enabled) {
    return round6(cfg.baseRiskPct);
  }

  const completed = safeNumber(weeklyStats?.completed, 0);

  const balanced = safeNumber(
    weeklyStats?.dashboardBalancedScore ??
    weeklyStats?.balancedScore,
    0
  );

  const fairWinrate = safeNumber(
    weeklyStats?.fairWinrate ??
    weeklyStats?.sampleAdjustedWinrate ??
    weeklyStats?.sampleWilsonLowerBound ??
    weeklyStats?.wilsonLowerBound,
    0
  );

  const sampleConf = clamp(
    completed / cfg.priorTrades,
    0,
    1
  );

  const qualityConf = clamp(
    balanced / 100,
    0,
    1
  );

  const winrateConf = fairWinrate > 0
    ? clamp((fairWinrate - 0.45) / 0.25, 0, 1)
    : 0;

  const confidence =
    sampleConf * 0.40 +
    qualityConf * 0.40 +
    winrateConf * 0.20;

  const maxMult = Math.max(cfg.minMult, cfg.maxMult);

  const mult = clamp(
    cfg.minMult + (maxMult - cfg.minMult) * confidence,
    cfg.minMult,
    maxMult
  );

  return round6(cfg.baseRiskPct * mult);
}

export function summarizeOpenRisk(openPositions = []) {
  const rows = Array.isArray(openPositions) ? openPositions : [];

  let total = 0;
  let longRisk = 0;
  let nonLongRisk = 0;
  let unknownSideRisk = 0;
  let counterBtcRisk = 0;

  for (const position of rows) {
    const risk = positionRiskFraction(position);
    const tradeSide = inferTradeSide(position);

    total += risk;

    if (tradeSide === TARGET_TRADE_SIDE) {
      longRisk += risk;
    } else if (tradeSide === 'UNKNOWN') {
      unknownSideRisk += risk;
      nonLongRisk += risk;
    } else {
      nonLongRisk += risk;
    }

    if (btcRelationFromRow(position) === 'BTC_AGAINST') {
      counterBtcRisk += risk;
    }
  }

  return {
    total: round6(total),

    longRisk: round6(longRisk),

    // Backward-compatible key. SHORT wordt niet meer gebruikt voor nieuwe sizing.
    shortRisk: 0,

    nonLongRisk: round6(nonLongRisk),
    nonShortRisk: round6(nonLongRisk),
    unknownSideRisk: round6(unknownSideRisk),
    counterBtcRisk: round6(counterBtcRisk),

    ...longModeFlags()
  };
}

export function checkRiskCaps({
  openPositions = [],
  side,
  tradeSide = side,
  btcRelation,
  riskFraction
} = {}) {
  const cfg = sizingConfig();
  const want = normalizeRiskFraction(riskFraction);
  const open = summarizeOpenRisk(openPositions);

  const requestedTradeSide = inferTradeSide({
    side,
    tradeSide,
    positionSide: tradeSide,
    direction: tradeSide,
    longOnly: tradeSide === TARGET_TRADE_SIDE || side === TARGET_TRADE_SIDE,
    shortDisabled: true
  });

  const relation = normalizeBtcRelation(btcRelation);

  if (requestedTradeSide !== TARGET_TRADE_SIDE) {
    return {
      ok: false,
      reason: 'LONG_ONLY_SYSTEM_REJECTED_NON_LONG_RISK',
      side,
      tradeSide: requestedTradeSide,
      riskFraction: 0,
      want,
      riskState: open,

      ...longModeFlags()
    };
  }

  if (want <= 0) {
    return {
      ok: false,
      reason: 'ZERO_RISK_FRACTION',
      side: TARGET_DASHBOARD_SIDE,
      tradeSide: TARGET_TRADE_SIDE,
      riskFraction: 0,
      want,
      riskState: open,

      ...longModeFlags()
    };
  }

  if (!cfg.enabled) {
    return {
      ok: true,
      reason: 'SIZING_DISABLED',
      riskFraction: want,
      openRiskBefore: open.total,
      openRiskAfter: round6(open.total + want),
      sideRiskAfter: round6(open.longRisk + want),
      riskState: open,

      ...longModeFlags()
    };
  }

  if (open.total + want > cfg.maxTotalRiskPct) {
    return {
      ok: false,
      reason: 'MAX_TOTAL_RISK',
      open: open.total,
      want,
      cap: cfg.maxTotalRiskPct,
      riskState: open,

      ...longModeFlags()
    };
  }

  if (open.longRisk + want > cfg.maxSameSideRiskPct) {
    return {
      ok: false,
      reason: 'MAX_LONG_SIDE_RISK',
      side: TARGET_TRADE_SIDE,
      open: open.longRisk,
      want,
      cap: cfg.maxSameSideRiskPct,
      riskState: open,

      ...longModeFlags()
    };
  }

  if (
    relation === 'BTC_AGAINST' &&
    open.counterBtcRisk + want > cfg.maxCounterBtcRiskPct
  ) {
    return {
      ok: false,
      reason: 'MAX_COUNTER_BTC_RISK',
      open: open.counterBtcRisk,
      want,
      cap: cfg.maxCounterBtcRiskPct,
      riskState: open,

      ...longModeFlags()
    };
  }

  return {
    ok: true,
    riskFraction: want,
    openRiskBefore: open.total,
    openRiskAfter: round6(open.total + want),
    sideRiskAfter: round6(open.longRisk + want),
    counterBtcRiskAfter: relation === 'BTC_AGAINST'
      ? round6(open.counterBtcRisk + want)
      : open.counterBtcRisk,
    riskState: open,

    ...longModeFlags()
  };
}