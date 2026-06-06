// ================= FILE: api/admin/rotation.js =================

import { CONFIG } from '../../src/config.js';
import { KEYS } from '../../src/keys.js';
import {
  getIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../../src/utils.js';
import {
  getDurableRedis,
  setJson
} from '../../src/redis.js';
import { getWeekMicros } from '../../src/analyze/analyzeEngine.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';

const ALLOWED_ACTIONS = [
  'activateBestBalanced',
  'activateBestSideMicro',
  'activateBestSideMicroFamily',
  'activateBestLongMicroFamily',
  'activateSelected',
  'activateSelectedMicroFamilies',
  'activateSelectedMacroFamilies'
];

const BLOCKED_SHORT_ACTIONS = new Set([
  'activateBestShortMicroFamily'
]);

const ALLOWED_MODES = new Set([
  'balanced',
  'winrate',
  'totalR',
  'avgR',
  'directSL',
  'observed'
]);

const DEFAULT_ACTIVE_ROWS_LIMIT = 60;
const DEFAULT_NEXT_ROWS_LIMIT = 25;
const MAX_ROWS_LIMIT = 160;

const DEFAULT_ROTATION_TOP_N = 50;
const MAX_ROTATION_TOP_N = 160;
const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE = 25;

const WEEK_ROWS_CACHE_TTL_MS = 20_000;
const WEEK_ROWS_CACHE_MAX_KEYS = 8;
const HARD_ROUTE_BUDGET_MS = 52_000;

const weekRowsCache = globalThis.__ADMIN_ROTATION_LONG_WEEK_ROWS_CACHE__ ||= new Map();

function now() {
  return Date.now();
}

function elapsed(startedAt) {
  return now() - startedAt;
}

function routeBudgetExceeded(startedAt, maxMs = HARD_ROUTE_BUDGET_MS) {
  return elapsed(startedAt) >= maxMs;
}

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET, POST');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET', 'POST'],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true
  });
}

function parseJson(text) {
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('INVALID_JSON_BODY');
    error.statusCode = 400;
    throw error;
  }
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === 'string') {
      return parseJson(req.body.trim());
    }

    if (Buffer.isBuffer(req.body)) {
      return parseJson(req.body.toString('utf8').trim());
    }

    return req.body;
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();

  return parseJson(text);
}

function firstValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function toLimit(value, fallback = DEFAULT_ACTIVE_ROWS_LIMIT, max = MAX_ROWS_LIMIT) {
  const n = Math.floor(Number(value));

  if (!Number.isFinite(n) || n < 1) return fallback;

  return Math.min(n, max);
}

function normalizeMode(value, fallback = 'balanced') {
  const mode = String(value || fallback).trim();

  return ALLOWED_MODES.has(mode) ? mode : fallback;
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => {
        if (Array.isArray(value)) return value;

        return String(value || '')
          .split(/[\s,]+/g)
          .map((part) => part.trim());
      })
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeFamilyIds(...values) {
  return uniqueStrings(values);
}

function num(value, fallback = 0) {
  return safeNumber(value, fallback);
}

function round(value, decimals = 4) {
  return Number(num(value, 0).toFixed(decimals));
}

async function getRedisJson(redis, key, fallback = null) {
  if (!key || !redis || typeof redis.get !== 'function') return fallback;

  const value = await redis.get(key);

  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getMacroSchema() {
  return String(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    CONFIG.analyze?.schema ||
    'MF_V1'
  ).toUpperCase();
}

function getMicroSchema() {
  return String(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  ).toUpperCase();
}

function idHasSchema(id, schema) {
  const value = String(id || '').toUpperCase();
  const target = String(schema || '').toUpperCase();

  if (!value || !target) return false;

  return (
    value.includes(`_${target}_`) ||
    value.endsWith(`_${target}`) ||
    value.includes(`SCHEMA=${target}`)
  );
}

function rowSchema(row = {}) {
  return String(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  ).toUpperCase();
}

function rowMicroId(row = {}) {
  return String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();
}

function normalizeRequestedTradeSide(value) {
  const raw = String(value || '').trim().toUpperCase();

  if (raw === 'LONG' || raw === 'BULL' || raw === 'BUY') return 'LONG';
  if (raw === 'SHORT' || raw === 'BEAR' || raw === 'SELL') return 'SHORT';

  const converted = sideToTradeSide(raw);

  if (converted === 'LONG') return 'LONG';
  if (converted === 'SHORT') return 'SHORT';

  return 'UNKNOWN';
}

function assertLongOnlySide(side) {
  if (side === TARGET_TRADE_SIDE) return;

  const error = new Error(
    side === 'SHORT'
      ? 'SHORT_DISABLED_LONG_ONLY'
      : 'VALID_SIDE_REQUIRED_LONG'
  );

  error.statusCode = 400;
  throw error;
}

function getDefinitionHaystack(row = {}) {
  return [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition,
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ]
    .map((value) => String(value || '').toUpperCase())
    .join(' | ');
}

function inferTradeSide(row = {}) {
  if (typeof row === 'string') {
    const value = row.toUpperCase();

    if (value.includes('MICRO_LONG_')) return 'LONG';
    if (value.includes('TRADESIDE=LONG')) return 'LONG';
    if (value.includes('TRADE_SIDE=LONG')) return 'LONG';
    if (value.includes('SIDE=LONG')) return 'LONG';
    if (value.includes('SIDE=BULL')) return 'LONG';
    if (value.includes('LONG')) return 'LONG';
    if (value.includes('BULL')) return 'LONG';
    if (value.includes('BUY')) return 'LONG';

    if (value.includes('MICRO_SHORT_')) return 'SHORT';
    if (value.includes('TRADESIDE=SHORT')) return 'SHORT';
    if (value.includes('TRADE_SIDE=SHORT')) return 'SHORT';
    if (value.includes('SIDE=SHORT')) return 'SHORT';
    if (value.includes('SIDE=BEAR')) return 'SHORT';
    if (value.includes('SHORT')) return 'SHORT';
    if (value.includes('BEAR')) return 'SHORT';
    if (value.includes('SELL')) return 'SHORT';

    return 'UNKNOWN';
  }

  const direct = sideToTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.entrySide ||
    row.bias ||
    row.marketBias
  );

  if (direct === 'LONG' || direct === 'SHORT') return direct;

  const rawSide = String(row.side || '').toUpperCase();

  if (['BULL', 'LONG', 'BUY', 'BULLISH'].includes(rawSide)) return 'LONG';
  if (['BEAR', 'SHORT', 'SELL', 'BEARISH'].includes(rawSide)) return 'SHORT';

  const familyId = String(row.familyId || row.family || row.baseFamilyId || '').toUpperCase();

  const macroFamilyId = String(
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    ''
  ).toUpperCase();

  const microFamilyId = String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).toUpperCase();

  if (familyId.startsWith('LONG_')) return 'LONG';
  if (familyId.startsWith('SHORT_')) return 'SHORT';

  if (macroFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (macroFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  if (microFamilyId.includes('MICRO_LONG_')) return 'LONG';
  if (microFamilyId.includes('MICRO_SHORT_')) return 'SHORT';

  const definition = getDefinitionHaystack(row);

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY')
  ) {
    return 'LONG';
  }

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL')
  ) {
    return 'SHORT';
  }

  if (microFamilyId.includes('LONG')) return 'LONG';
  if (macroFamilyId.includes('LONG')) return 'LONG';

  if (microFamilyId.includes('SHORT')) return 'SHORT';
  if (macroFamilyId.includes('SHORT')) return 'SHORT';

  return 'UNKNOWN';
}

function isLongRow(row = {}) {
  return inferTradeSide(row) !== 'SHORT';
}

function isLongId(id = '') {
  return inferTradeSide(String(id || '')) !== 'SHORT';
}

function normalizeDashboardSide() {
  return TARGET_DASHBOARD_SIDE;
}

function getFamilyId(row = {}) {
  return (
    row.familyId ||
    row.family ||
    row.baseFamilyId ||
    null
  );
}

function getMacroFamilyId(row = {}) {
  return (
    row.parentMacroFamilyId ||
    row.macroFamilyId ||
    row.parentMicroFamilyId ||
    row.parentFamilyId ||
    row.macroId ||
    row.familyId ||
    null
  );
}

function getDefinitionParts(row = {}) {
  if (Array.isArray(row.definitionParts)) return row.definitionParts;
  if (Array.isArray(row.microDefinitionParts)) return row.microDefinitionParts;
  if (Array.isArray(row.definition)) return row.definition;

  return [];
}

function getMacroDefinitionParts(row = {}) {
  if (Array.isArray(row.macroDefinitionParts)) return row.macroDefinitionParts;
  if (Array.isArray(row.parentDefinitionParts)) return row.parentDefinitionParts;

  return [];
}

function isLegacyMacroFamilyRow(row = {}) {
  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();
  const macroSchema = getMacroSchema();

  if (!row || !id) return false;
  if (inferTradeSide(row) === 'SHORT') return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (schema === macroSchema) return true;
  if (idHasSchema(id, macroSchema)) return true;

  return false;
}

function isTrueMicroFamilyRow(row = {}) {
  const id = rowMicroId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  const macroSchema = getMacroSchema();
  const microSchema = getMicroSchema();

  if (!row || !id) return false;
  if (inferTradeSide(row) === 'SHORT') return false;

  if (row.isTrueMicro === true || row.trueMicro === true) return true;
  if (version.includes('MICRO')) return true;
  if (schema === microSchema) return true;
  if (idHasSchema(id, microSchema)) return true;

  if (row.isLegacyMacro === true) return false;
  if (version.includes('MACRO')) return false;
  if (schema === macroSchema) return false;
  if (idHasSchema(id, macroSchema)) return false;

  const macroId = getMacroFamilyId(row);

  return Boolean(macroId && macroId !== id);
}

function normalizeRotationRow(row = {}, index = 0) {
  const microFamilyId = row.microFamilyId || row.trueMicroFamilyId || row.id || row.key || null;

  if (!microFamilyId) return null;

  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId
  });

  const inferredTradeSide = inferTradeSide({
    ...row,
    microFamilyId,
    macroFamilyId
  });

  if (inferredTradeSide === 'SHORT') return null;

  const normalized = {
    rank: num(row.rank, index + 1),

    microFamilyId,
    trueMicroFamilyId: microFamilyId,
    familyId: getFamilyId(row),
    macroFamilyId,

    parentMacroFamilyId: row.parentMacroFamilyId || macroFamilyId || null,
    parentMicroFamilyId: row.parentMicroFamilyId || macroFamilyId || null,

    side: normalizeDashboardSide(),
    tradeSide: TARGET_TRADE_SIDE,
    inferredTradeSide,
    inferredFromLongOnlyMode: inferredTradeSide === 'UNKNOWN',

    schema: row.schema || row.microFamilySchema || null,
    microFamilySchema: row.microFamilySchema || row.schema || null,
    version: row.version || null,

    isTrueMicro: row.isTrueMicro === true || row.trueMicro === true,
    isLegacyMacro: Boolean(row.isLegacyMacro),

    seen: num(row.seen, 0),
    observations: num(row.observations, 0),

    completed: round(row.completed, 4),
    realCompleted: num(row.realCompleted, 0),
    shadowCompleted: num(row.shadowCompleted, 0),

    wins: round(row.wins, 4),
    losses: round(row.losses, 4),
    flats: round(row.flats, 4),

    realWins: num(row.realWins, 0),
    realLosses: num(row.realLosses, 0),
    realFlats: num(row.realFlats, 0),

    shadowWins: num(row.shadowWins, 0),
    shadowLosses: num(row.shadowLosses, 0),
    shadowFlats: num(row.shadowFlats, 0),

    winrateSample: round(row.winrateSample ?? row.completed, 4),
    winrate: round(row.winrate, 4),
    bayesianWinrate: round(row.bayesianWinrate, 4),
    wilsonLowerBound: round(row.wilsonLowerBound, 4),
    fairWinrate: round(
      row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      row.bayesianWinrate ??
      row.wilsonLowerBound,
      4
    ),
    sampleAdjustedWinrate: round(row.sampleAdjustedWinrate, 4),
    sampleWilsonLowerBound: round(row.sampleWilsonLowerBound ?? row.wilsonLowerBound, 4),
    sampleReliability: round(row.sampleReliability, 4),

    avgR: round(row.avgR, 4),
    totalR: round(row.totalR, 4),
    avgWinR: round(row.avgWinR, 4),
    avgLossR: round(row.avgLossR, 4),

    profitFactor: round(row.profitFactor, 4),

    directSLPct: round(row.directSLPct, 4),
    nearTpPct: round(row.nearTpPct, 4),
    reachedHalfRPct: round(row.reachedHalfRPct, 4),
    reachedOneRPct: round(row.reachedOneRPct, 4),

    beWouldExitPct: round(row.beWouldExitPct, 4),
    gaveBackAfterHalfRPct: round(row.gaveBackAfterHalfRPct, 4),
    gaveBackAfterOneRPct: round(row.gaveBackAfterOneRPct, 4),
    nearTpThenLossPct: round(row.nearTpThenLossPct, 4),

    totalCostR: round(row.totalCostR, 4),
    avgCostR: round(row.avgCostR, 4),

    balancedScore: round(row.balancedScore, 4),
    dashboardBalancedScore: round(row.dashboardBalancedScore ?? row.balancedScore, 4),

    assetClass: row.assetClass || null,

    rsiZone: row.rsiZone || null,
    rsiCoarse: row.rsiCoarse || null,

    flow: row.flow || null,
    flowCoarse: row.flowCoarse || null,

    obRelation: row.obRelation || null,

    btcState: row.btcState || null,
    btcRelation: row.btcRelation || null,

    regime: row.regime || null,
    regimeCoarse: row.regimeCoarse || null,

    scannerReason: row.scannerReason || null,
    scannerReasonCoarse: row.scannerReasonCoarse || null,

    definitionParts: getDefinitionParts(row),
    definition: row.definition || '',

    macroDefinitionParts: getMacroDefinitionParts(row),
    macroDefinition: row.macroDefinition || row.parentDefinition || '',

    selectedTier: row.selectedTier || row.rotationEligibilityTier || row.eligibilityTier || null,
    rotationEligibilityTier: row.rotationEligibilityTier || row.selectedTier || row.eligibilityTier || null,

    manualOnly: Boolean(row.manualOnly),

    isMirrorMicroFamily: Boolean(row.isMirrorMicroFamily),
    observationMirror: Boolean(row.observationMirror),
    analysisMirror: Boolean(row.analysisMirror),
    mirrorAnalysisOnly: Boolean(row.mirrorAnalysisOnly),

    sourceWeekPrimary: Boolean(row.sourceWeekPrimary),
    sourceWeekFallback: Boolean(row.sourceWeekFallback)
  };

  normalized.isLegacyMacro = isLegacyMacroFamilyRow(normalized);
  normalized.isTrueMicro = isTrueMicroFamilyRow(normalized);

  return normalized;
}

function buildSelectionIndexes(microFamilies = []) {
  const rows = (Array.isArray(microFamilies) ? microFamilies : [])
    .filter(Boolean)
    .filter(isLongRow)
    .filter(isTrueMicroFamilyRow);

  const microFamilyIds = normalizeFamilyIds(
    rows.map((row) => row.microFamilyId)
  );

  const macroFamilyIds = normalizeFamilyIds(
    rows.map((row) => row.macroFamilyId)
  );

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of rows) {
    const microId = String(row.microFamilyId || '').trim();
    const macroId = String(row.macroFamilyId || '').trim();

    if (!microId || !macroId) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = normalizeFamilyIds(
      macroToMicroFamilyIds[macroId]
    );
  }

  return {
    microFamilyIds,
    macroFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,
    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

function microIdsFromRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  return normalizeFamilyIds(
    rotation.microFamilyIds,
    rotation.activeMicroFamilyIds,
    rotation.trueMicroFamilyIds,
    rotation.ids,
    rows.map((row) => row?.microFamilyId)
  )
    .filter(isLongId);
}

function macroIdsFromRotation(rotation = {}, microFamilyIds = []) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies.filter(isLongRow)
    : [];

  const macroIds = normalizeFamilyIds(
    rotation.macroFamilyIds,
    rotation.activeMacroFamilyIds,
    rows.map((row) => getMacroFamilyId(row))
  )
    .filter(isLongId);

  if (macroIds.length > 0) return macroIds;

  return normalizeFamilyIds(microFamilyIds)
    .filter(isLongId);
}

function missingSides(rows = []) {
  const hasLong = rows.some((row) => row?.tradeSide === TARGET_TRADE_SIDE);

  return hasLong ? [] : [TARGET_TRADE_SIDE];
}

function normalizeRotation(rotation = {}, fallback = {}, options = {}) {
  const base = {
    ...fallback,
    ...(rotation || {})
  };

  const rowLimit = toLimit(
    options.rowLimit,
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ROWS_LIMIT
  );

  const rawRows = Array.isArray(base.microFamilies)
    ? base.microFamilies
    : [];

  const normalizedRawRows = rawRows
    .map((row, index) => normalizeRotationRow(row, index))
    .filter(Boolean)
    .filter(isLongRow)
    .filter(isTrueMicroFamilyRow);

  const microFamilies = normalizedRawRows.slice(0, rowLimit);

  const explicitMicroFamilyIds = normalizeFamilyIds(
    microIdsFromRotation({
      ...base,
      microFamilies: rawRows
    }),
    rawRows.map((row) => row?.microFamilyId)
  )
    .filter(isLongId);

  const explicitMacroFamilyIds = normalizeFamilyIds(
    macroIdsFromRotation({
      ...base,
      microFamilies: rawRows
    }, explicitMicroFamilyIds),
    rawRows.map((row) => getMacroFamilyId(row))
  )
    .filter(isLongId);

  const indexes = buildSelectionIndexes(normalizedRawRows);

  const microFamilyIds = indexes.microFamilyIds.length
    ? indexes.microFamilyIds
    : explicitMicroFamilyIds.filter((id) => (
      normalizedRawRows.some((row) => row.microFamilyId === id)
    ));

  const macroFamilyIds = indexes.macroFamilyIds.length
    ? indexes.macroFamilyIds
    : explicitMacroFamilyIds;

  const bestLong =
    normalizedRawRows.find((row) => row.tradeSide === TARGET_TRADE_SIDE) ||
    (base.bestLong ? normalizeRotationRow(base.bestLong, 0) : null);

  const empty = base.empty ?? microFamilyIds.length === 0;

  return {
    rotationId: base.rotationId || null,
    source: base.source || null,
    mode: base.mode || null,
    sideMode: 'long_only',

    sourceWeekKey: base.sourceWeekKey || null,
    activeWeekKey: base.activeWeekKey || null,

    generatedAt: base.generatedAt || null,
    activatedAt: base.activatedAt || null,
    strategyVersion: base.strategyVersion || CONFIG.strategyVersion || null,

    schema: base.schema || null,
    macroSchema: base.macroSchema || getMacroSchema(),
    microSchema: base.microSchema || getMicroSchema(),

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: Boolean(base.usedSoftFallback),
    usedObservationFallback: Boolean(base.usedObservationFallback),
    usedPreviousWeekMerge: Boolean(base.usedPreviousWeekMerge),

    selectedTier: base.selectedTier || null,
    requestedTradeSide: TARGET_TRADE_SIDE,
    preservedTradeSide: null,
    replacedSide: TARGET_TRADE_SIDE,
    preservedSide: null,

    minWeightedCompleted: base.minWeightedCompleted ?? null,
    topNPerSide: base.topNPerSide ?? null,
    maxPerMacroFamily: base.maxPerMacroFamily ?? null,

    eligibleCount: base.eligibleCount ?? null,
    softEligibleCount: base.softEligibleCount ?? null,
    observationEligibleCount: base.observationEligibleCount ?? null,
    rankedCount: base.rankedCount ?? null,
    allRankedCount: base.allRankedCount ?? null,
    microCount: microFamilyIds.length || base.microCount || normalizedRawRows.length || 0,
    macroCount: macroFamilyIds.length || base.macroCount || 0,
    trueMicroCount: microFamilyIds.length,
    legacyMacroCount: base.legacyMacroCount ?? 0,

    empty,
    emptyReason: empty
      ? base.emptyReason || 'NO_ACTIVE_LONG_TRUE_MICRO_FAMILIES'
      : base.emptyReason || null,

    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId: Object.keys(indexes.microToMacroFamilyId).length
      ? indexes.microToMacroFamilyId
      : base.microToMacroFamilyId || {},

    macroToMicroFamilyIds: Object.keys(indexes.macroToMicroFamilyIds).length
      ? indexes.macroToMicroFamilyIds
      : base.macroToMicroFamilyIds || {},

    microFamilies,

    rowsTruncated: normalizedRawRows.length > microFamilies.length,
    rowsReturned: microFamilies.length,
    rowsTotal: normalizedRawRows.length,

    selectedMicroFamilyId: base.selectedMicroFamilyId || bestLong?.microFamilyId || null,
    selectedMacroFamilyId: base.selectedMacroFamilyId || bestLong?.macroFamilyId || null,

    selectedRow: base.selectedRow
      ? normalizeRotationRow(base.selectedRow, 0)
      : bestLong,

    preservedOppositeRow: null,

    previousActiveMicroFamilyIds: normalizeFamilyIds(base.previousActiveMicroFamilyIds || [])
      .filter(isLongId),

    previousActiveMacroFamilyIds: normalizeFamilyIds(base.previousActiveMacroFamilyIds || [])
      .filter(isLongId),

    requestedMicroFamilyIds: normalizeFamilyIds(base.requestedMicroFamilyIds || [])
      .filter(isLongId),

    ignoredRequestedIds: Array.isArray(base.ignoredRequestedIds)
      ? base.ignoredRequestedIds
      : [],

    expandedFromMacro: base.expandedFromMacro || {},

    bestLong,
    bestShort: null,
    missingSides: missingSides(normalizedRawRows),

    count: microFamilyIds.length || microFamilies.length,
    activeCount: microFamilyIds.length || microFamilies.length
  };
}

function normalizeDashboardFromStored({
  activeRaw,
  nextRaw,
  validFrom,
  activeRowsLimit = DEFAULT_ACTIVE_ROWS_LIMIT,
  nextRowsLimit = DEFAULT_NEXT_ROWS_LIMIT
} = {}) {
  const active = normalizeRotation(activeRaw || {}, {}, {
    rowLimit: activeRowsLimit
  });

  const next = normalizeRotation(nextRaw || {}, {}, {
    rowLimit: nextRowsLimit
  });

  const activeRows = Array.isArray(active.microFamilies)
    ? active.microFamilies
    : [];

  const nextRows = Array.isArray(next.microFamilies)
    ? next.microFamilies
    : [];

  return {
    active,
    next,
    validFrom,

    activeRotation: active,
    nextRotation: next,

    activeRows,
    nextRows,

    activeCount: active.microFamilyIds.length || activeRows.length,
    nextCount: next.microFamilyIds.length || nextRows.length,

    activeMacroCount: active.macroFamilyIds.length,
    nextMacroCount: next.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    nextMicroFamilyIds: next.microFamilyIds,
    nextMacroFamilyIds: next.macroFamilyIds,

    activeMicroToMacroFamilyId: active.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next.microToMacroFamilyId || {},

    activeMacroToMicroFamilyIds: active.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next.macroToMicroFamilyIds || {},

    bestLong: active.bestLong,
    bestShort: null,

    nextBestLong: next.bestLong,
    nextBestShort: null,

    missingSides: active.missingSides || [],
    nextMissingSides: next.missingSides || [],

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true
  };
}

async function getStoredRotationDashboard(options = {}) {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getRedisJson(redis, KEYS.analyze?.activeRotation, null),
    getRedisJson(redis, KEYS.analyze?.nextRotation, null),
    getRedisJson(redis, KEYS.analyze?.rotationValidFrom, null)
  ]);

  return normalizeDashboardFromStored({
    activeRaw,
    nextRaw,
    validFrom,
    ...options
  });
}

async function getStoredActiveRotation() {
  const redis = getDurableRedis();
  const activeRaw = await getRedisJson(redis, KEYS.analyze?.activeRotation, null);

  return normalizeRotation(activeRaw || {}, {}, {
    rowLimit: DEFAULT_ACTIVE_ROWS_LIMIT
  });
}

async function handleGet(req, res) {
  const requestStartedAt = now();

  const activeRowsLimit = toLimit(
    firstValue(req.query?.activeRowsLimit, DEFAULT_ACTIVE_ROWS_LIMIT),
    DEFAULT_ACTIVE_ROWS_LIMIT,
    MAX_ROWS_LIMIT
  );

  const nextRowsLimit = toLimit(
    firstValue(req.query?.nextRowsLimit, DEFAULT_NEXT_ROWS_LIMIT),
    DEFAULT_NEXT_ROWS_LIMIT,
    MAX_ROWS_LIMIT
  );

  const dashboard = await getStoredRotationDashboard({
    activeRowsLimit,
    nextRowsLimit
  });

  return res.status(200).json({
    ok: true,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    currentWeekKey: getIsoWeekKey(),
    previousWeekKey: getPreviousIsoWeekKey(),

    activeRowsLimit,
    nextRowsLimit,

    ...dashboard,

    perf: {
      durationMs: elapsed(requestStartedAt),
      source: 'stored_redis_only_long_true_micro_filtered',
      avoidsAnalyzeEngineDashboard: true
    },

    serverTs: Date.now()
  });
}

function selectedIdsFromBody(body = {}) {
  const allIds = normalizeFamilyIds(
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds,
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids
  );

  const explicitMacroIds = normalizeFamilyIds(
    body.macroFamilyIds,
    body.activeMacroFamilyIds,
    body.macroIds
  )
    .filter(isLongId);

  const explicitMicroIds = normalizeFamilyIds(
    body.microFamilyIds,
    body.activeMicroFamilyIds,
    body.trueMicroFamilyIds,
    body.ids
  )
    .filter(isLongId);

  const ignoredShortIds = allIds
    .filter((id) => inferTradeSide(id) === 'SHORT');

  return {
    microFamilyIds: explicitMicroIds,
    macroFamilyIds: explicitMacroIds,
    ignoredShortIds
  };
}

function rowMatchesSelection(row, microSet, macroSet) {
  if (!isLongRow(row)) return false;
  if (!isTrueMicroFamilyRow(row)) return false;

  const microFamilyId = row.microFamilyId || row.id || row.key || null;

  const macroFamilyId = getMacroFamilyId({
    ...row,
    microFamilyId
  });

  return (
    (microFamilyId && microSet.has(microFamilyId)) ||
    (macroFamilyId && macroSet.has(macroFamilyId)) ||
    (microFamilyId && macroSet.has(microFamilyId))
  );
}

function buildManualRow(id, index = 0, type = 'micro') {
  if (!isLongId(id)) return null;

  const microFamilyId = id;
  const macroFamilyId = type === 'macro'
    ? id
    : null;

  return normalizeRotationRow({
    rank: index + 1,
    microFamilyId,
    macroFamilyId,

    familyId: null,
    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    schema: getMicroSchema(),
    microFamilySchema: getMicroSchema(),
    version: 'micro',
    isTrueMicro: type !== 'macro',
    isLegacyMacro: type === 'macro',

    seen: 0,
    observations: 0,
    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    fairWinrate: 0,
    winrateSample: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedOneRPct: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    definitionParts: [],
    definition: '',

    manualOnly: true
  }, index);
}

function dedupeRows(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    if (!row || !isLongRow(row)) continue;
    if (!isTrueMicroFamilyRow(row)) continue;

    const key = row.microFamilyId || row.macroFamilyId;

    if (!key || seen.has(key)) continue;

    seen.add(key);
    output.push(row);
  }

  return output
    .map((row, index) => normalizeRotationRow(row, index))
    .filter(Boolean)
    .filter(isTrueMicroFamilyRow);
}

function scoreByMode(row = {}, mode = 'balanced') {
  if (mode === 'winrate') {
    return num(
      row.fairWinrate ??
      row.sampleAdjustedWinrate ??
      row.bayesianWinrate ??
      row.wilsonLowerBound ??
      row.winrate,
      0
    );
  }

  if (mode === 'totalR') {
    return num(row.totalR, 0);
  }

  if (mode === 'avgR') {
    return num(row.avgRScore ?? row.avgR, 0);
  }

  if (mode === 'directSL') {
    return -num(row.directSLPct, 1);
  }

  if (mode === 'observed') {
    return num(
      row.completed ??
      row.winrateSample ??
      row.realCompleted ??
      row.shadowCompleted ??
      row.seen ??
      row.observations,
      0
    );
  }

  return num(row.dashboardBalancedScore ?? row.balancedScore, 0);
}

function compareRowsByMode(a = {}, b = {}, mode = 'balanced') {
  const scoreDiff = scoreByMode(b, mode) - scoreByMode(a, mode);

  if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;

  const completedDiff = num(b.completed, 0) - num(a.completed, 0);
  if (Math.abs(completedDiff) > 1e-12) return completedDiff;

  const winrateSampleDiff = num(b.winrateSample, 0) - num(a.winrateSample, 0);
  if (Math.abs(winrateSampleDiff) > 1e-12) return winrateSampleDiff;

  const totalRDiff = num(b.totalR, 0) - num(a.totalR, 0);
  if (Math.abs(totalRDiff) > 1e-12) return totalRDiff;

  const avgRDiff = num(b.avgR, 0) - num(a.avgR, 0);
  if (Math.abs(avgRDiff) > 1e-12) return avgRDiff;

  const seenDiff = Math.max(num(b.seen, 0), num(b.observations, 0)) -
    Math.max(num(a.seen, 0), num(a.observations, 0));

  if (Math.abs(seenDiff) > 1e-12) return seenDiff;

  return String(a.microFamilyId || '').localeCompare(String(b.microFamilyId || ''));
}

function sortRowsByMode(rows = [], mode = 'balanced') {
  return [...rows]
    .filter(Boolean)
    .filter(isLongRow)
    .filter(isTrueMicroFamilyRow)
    .sort((a, b) => compareRowsByMode(a, b, mode));
}

function rotationMinCompleted() {
  return num(CONFIG.rotation?.minWeightedCompleted, 5);
}

function rotationTopN(body = {}) {
  return toLimit(
    firstValue(
      body.topN,
      firstValue(
        body.limit,
        firstValue(
          body.activeRowsLimit,
          CONFIG.rotation?.topNPerSide ?? DEFAULT_ROTATION_TOP_N
        )
      )
    ),
    DEFAULT_ROTATION_TOP_N,
    MAX_ROTATION_TOP_N
  );
}

function rotationMaxPerMacroFamily(body = {}) {
  const raw = firstValue(
    body.maxPerMacroFamily,
    CONFIG.rotation?.maxPerMacroFamily ?? 0
  );

  const n = Math.floor(Number(raw));

  if (!Number.isFinite(n) || n < 1) return 0;

  return Math.min(n, MAX_ROTATION_TOP_N);
}

function minPrimaryRowsForPreviousMerge(body = {}) {
  return toLimit(
    firstValue(
      body.minPrimaryRowsForMerge,
      CONFIG.rotation?.minPrimaryRowsForPreviousMerge ??
        DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE
    ),
    DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
    MAX_ROTATION_TOP_N
  );
}

function rowHasHardEligibility(row = {}) {
  return num(row.completed, 0) >= rotationMinCompleted();
}

function rowHasSoftEligibility(row = {}) {
  if (num(row.completed, 0) <= 0) return false;

  return (
    num(row.dashboardBalancedScore ?? row.balancedScore, 0) > 0 ||
    num(row.avgR, 0) > 0 ||
    num(row.totalR, 0) > 0 ||
    num(row.fairWinrate ?? row.sampleAdjustedWinrate, 0) > 0 ||
    num(row.wilsonLowerBound ?? row.sampleWilsonLowerBound, 0) > 0
  );
}

function rowHasObservationEligibility(row = {}) {
  return Math.max(
    num(row.seen, 0),
    num(row.observations, 0),
    num(row.winrateSample, 0),
    num(row.realCompleted, 0),
    num(row.shadowCompleted, 0)
  ) > 0;
}

function rowEligibilityTier(row = {}) {
  if (rowHasHardEligibility(row)) return 'HARD';
  if (rowHasSoftEligibility(row)) return 'SOFT';
  if (rowHasObservationEligibility(row)) return 'OBSERVATION';

  return 'NONE';
}

function rowsByEligibility(sideRows = []) {
  const hardRows = [];
  const softRows = [];
  const observationRows = [];

  for (const row of sideRows.filter(isLongRow).filter(isTrueMicroFamilyRow)) {
    if (rowHasHardEligibility(row)) {
      hardRows.push(row);
      continue;
    }

    if (rowHasSoftEligibility(row)) {
      softRows.push(row);
      continue;
    }

    if (rowHasObservationEligibility(row)) {
      observationRows.push(row);
    }
  }

  return {
    hardRows,
    softRows,
    observationRows
  };
}

function selectTopRotationRows(rows = [], {
  mode = 'balanced',
  topN = DEFAULT_ROTATION_TOP_N,
  maxPerMacroFamily = 0
} = {}) {
  const sorted = sortRowsByMode(rows, mode);
  const output = [];
  const byMacro = {};

  for (const row of sorted) {
    if (output.length >= topN) break;

    const macroId = String(row.macroFamilyId || row.parentMacroFamilyId || 'NO_MACRO').trim();

    if (maxPerMacroFamily > 0) {
      byMacro[macroId] = byMacro[macroId] || 0;

      if (byMacro[macroId] >= maxPerMacroFamily) continue;

      byMacro[macroId] += 1;
    }

    output.push(row);
  }

  return output
    .map((row, index) => normalizeRotationRow({
      ...row,
      rank: index + 1
    }, index))
    .filter(Boolean)
    .filter(isTrueMicroFamilyRow);
}

function pruneWeekRowsCache() {
  const entries = [...weekRowsCache.entries()];

  if (entries.length <= WEEK_ROWS_CACHE_MAX_KEYS) return;

  entries
    .sort((a, b) => num(a[1]?.ts, 0) - num(b[1]?.ts, 0))
    .slice(0, Math.max(0, entries.length - WEEK_ROWS_CACHE_MAX_KEYS))
    .forEach(([key]) => weekRowsCache.delete(key));
}

function microsSignature(micros = {}) {
  const keys = Object.keys(micros || {});
  const count = keys.length;

  if (count <= 0) return '0';

  const first = keys[0] || '';
  const middle = keys[Math.floor(count / 2)] || '';
  const last = keys[count - 1] || '';

  return `${count}:${first}:${middle}:${last}`;
}

async function getSingleWeekRows(weekKey, startedAt = now()) {
  const micros = await getWeekMicros(weekKey);
  const signature = microsSignature(micros);
  const cacheKey = `LONG_TRUE_MICRO|${weekKey}|${signature}`;
  const cached = weekRowsCache.get(cacheKey);

  if (cached && now() - cached.ts < WEEK_ROWS_CACHE_TTL_MS) {
    return {
      weekKey,
      rows: cached.rows,
      micros,
      cacheHit: true,
      cacheKey
    };
  }

  const entries = Object.entries(micros || {});
  const rows = [];

  for (let index = 0; index < entries.length; index += 1) {
    if (routeBudgetExceeded(startedAt)) break;

    const [key, row] = entries[index];

    const normalized = normalizeRotationRow({
      ...row,
      key,
      microFamilyId: row?.microFamilyId || row?.trueMicroFamilyId || key
    }, index);

    if (normalized?.microFamilyId && isTrueMicroFamilyRow(normalized)) {
      rows.push(normalized);
    }
  }

  weekRowsCache.set(cacheKey, {
    ts: now(),
    rows
  });

  pruneWeekRowsCache();

  return {
    weekKey,
    rows,
    micros,
    cacheHit: false,
    cacheKey
  };
}

function mergeWeekRows(primaryRows = [], fallbackRows = []) {
  const byKey = new Map();

  for (const row of fallbackRows) {
    const key = row.microFamilyId;
    if (!key) continue;

    byKey.set(key, {
      ...row,
      sourceWeekFallback: true
    });
  }

  for (const row of primaryRows) {
    const key = row.microFamilyId;
    if (!key) continue;

    byKey.set(key, {
      ...row,
      sourceWeekPrimary: true
    });
  }

  return [...byKey.values()]
    .map((row, index) => normalizeRotationRow(row, index))
    .filter(Boolean)
    .filter(isTrueMicroFamilyRow);
}

async function getWeekRows(weekKey, startedAt = now(), options = {}) {
  const minRowsForMerge = toLimit(
    options.minPrimaryRowsForMerge,
    DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
    MAX_ROTATION_TOP_N
  );

  const primary = await getSingleWeekRows(weekKey, startedAt);
  const previousWeekKey = getPreviousIsoWeekKey();

  const shouldTryPrevious =
    weekKey !== previousWeekKey &&
    primary.rows.length < minRowsForMerge &&
    !routeBudgetExceeded(startedAt);

  if (!shouldTryPrevious) {
    return {
      ...primary,
      source: 'requestedWeek',
      primaryWeekKey: weekKey,
      previousWeekKey,
      primaryRows: primary.rows.length,
      previousRows: 0,
      mergedPreviousWeek: false
    };
  }

  const previous = await getSingleWeekRows(previousWeekKey, startedAt).catch(() => ({
    weekKey: previousWeekKey,
    rows: [],
    micros: {},
    cacheHit: false,
    cacheKey: null
  }));

  if (!previous.rows.length) {
    return {
      ...primary,
      source: 'requestedWeekLowRowsNoPreviousFallback',
      primaryWeekKey: weekKey,
      previousWeekKey,
      primaryRows: primary.rows.length,
      previousRows: 0,
      mergedPreviousWeek: false
    };
  }

  const rows = mergeWeekRows(primary.rows, previous.rows);

  return {
    weekKey,
    rows,
    micros: {
      ...(previous.micros || {}),
      ...(primary.micros || {})
    },
    cacheHit: Boolean(primary.cacheHit && previous.cacheHit),
    cacheKey: `${primary.cacheKey}|MERGED_WITH|${previous.cacheKey}`,
    source: 'requestedWeekMergedWithPreviousWeek',
    primaryWeekKey: weekKey,
    previousWeekKey,
    primaryRows: primary.rows.length,
    previousRows: previous.rows.length,
    mergedPreviousWeek: true
  };
}

async function findBestWeekLongRows({
  weekKey,
  mode,
  topN = DEFAULT_ROTATION_TOP_N,
  maxPerMacroFamily = 0,
  minPrimaryRowsForMerge = DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
  startedAt = now()
} = {}) {
  const weekResult = await getWeekRows(weekKey, startedAt, {
    minPrimaryRowsForMerge
  });

  const rows = weekResult.rows || [];
  const sideRows = rows
    .filter(isLongRow)
    .filter(isTrueMicroFamilyRow);

  const {
    hardRows,
    softRows,
    observationRows
  } = rowsByEligibility(sideRows);

  let candidateRows = hardRows;
  let selectedTier = 'HARD';

  if (candidateRows.length === 0) {
    candidateRows = softRows;
    selectedTier = 'SOFT';
  }

  if (candidateRows.length === 0) {
    candidateRows = observationRows;
    selectedTier = 'OBSERVATION';
  }

  if (candidateRows.length === 0) {
    candidateRows = sideRows;
    selectedTier = 'RAW_SIDE';
  }

  const selectedRows = selectTopRotationRows(candidateRows, {
    mode,
    topN,
    maxPerMacroFamily
  });

  const best = selectedRows[0] || null;

  return {
    best: best
      ? normalizeRotationRow({
        ...best,
        rotationEligibilityTier: rowEligibilityTier(best),
        selectedTier
      })
      : null,

    selectedRows: selectedRows.map((row, index) => normalizeRotationRow({
      ...row,
      rotationEligibilityTier: rowEligibilityTier(row),
      selectedTier,
      rank: index + 1
    }, index)).filter(Boolean),

    rows,
    sideRows,
    candidateRows,

    sideCount: sideRows.length,
    candidateCount: candidateRows.length,

    hardCount: hardRows.length,
    softCount: softRows.length,
    observationCount: observationRows.length,

    tradableCount: hardRows.length + softRows.length + observationRows.length,
    selectedTier,

    topN,
    maxPerMacroFamily,

    weekRowsCacheHit: weekResult.cacheHit,
    weekRowsCacheKey: weekResult.cacheKey,
    scannedRows: rows.length,

    source: weekResult.source,
    primaryWeekKey: weekResult.primaryWeekKey,
    previousWeekKey: weekResult.previousWeekKey,
    primaryRows: weekResult.primaryRows,
    previousRows: weekResult.previousRows,
    mergedPreviousWeek: weekResult.mergedPreviousWeek
  };
}

async function buildSelectedRotationRows({
  weekKey,
  microFamilyIds = [],
  macroFamilyIds = [],
  minPrimaryRowsForMerge = DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_WEEK_MERGE,
  startedAt = now()
} = {}) {
  const weekResult = await getWeekRows(weekKey, startedAt, {
    minPrimaryRowsForMerge
  });

  const rows = weekResult.rows || [];
  const micros = weekResult.micros || {};

  const microSet = new Set(microFamilyIds.filter(isLongId));
  const macroSet = new Set(macroFamilyIds.filter(isLongId));

  const matchedRows = [];

  for (const row of rows) {
    if (routeBudgetExceeded(startedAt)) break;
    if (rowMatchesSelection(row, microSet, macroSet)) matchedRows.push(row);
  }

  const matchedMicroIds = new Set(matchedRows.map((row) => row.microFamilyId).filter(Boolean));
  const matchedMacroIds = new Set(matchedRows.map((row) => row.macroFamilyId).filter(Boolean));

  const missingMicroRows = microFamilyIds
    .filter(isLongId)
    .filter((id) => !matchedMicroIds.has(id) && !matchedMacroIds.has(id))
    .map((id, index) => buildManualRow(id, matchedRows.length + index, 'micro'))
    .filter(Boolean)
    .filter(isTrueMicroFamilyRow);

  return {
    rows: dedupeRows([
      ...matchedRows,
      ...missingMicroRows
    ]),
    weekRowsCacheHit: weekResult.cacheHit,
    weekRowsCacheKey: weekResult.cacheKey,
    scannedRows: rows.length,
    microsCount: Object.keys(micros || {}).length,
    source: weekResult.source,
    primaryWeekKey: weekResult.primaryWeekKey,
    previousWeekKey: weekResult.previousWeekKey,
    primaryRows: weekResult.primaryRows,
    previousRows: weekResult.previousRows,
    mergedPreviousWeek: weekResult.mergedPreviousWeek
  };
}

async function persistActiveRotation(active) {
  const normalizedActive = normalizeRotation(active, {}, {
    rowLimit: MAX_ROWS_LIMIT
  });

  await setJson(
    getDurableRedis(),
    KEYS.analyze.activeRotation,
    normalizedActive
  );

  return normalizedActive;
}

async function activateBestBalanced(body, startedAt = now()) {
  const sourceWeekKey = firstValue(
    body.weekKey,
    getIsoWeekKey()
  );

  const activeWeekKey = firstValue(
    body.activeWeekKey,
    getIsoWeekKey()
  );

  const mode = normalizeMode(
    firstValue(body.mode, 'balanced'),
    'balanced'
  );

  const topN = rotationTopN(body);
  const maxPerMacroFamily = rotationMaxPerMacroFamily(body);
  const minMergeRows = minPrimaryRowsForPreviousMerge(body);

  const sideResult = await findBestWeekLongRows({
    weekKey: sourceWeekKey,
    mode,
    topN,
    maxPerMacroFamily,
    minPrimaryRowsForMerge: minMergeRows,
    startedAt
  });

  const selectedRow = sideResult.best;
  const microFamilies = dedupeRows(sideResult.selectedRows || []);

  if (!selectedRow || microFamilies.length === 0) {
    const previousActive = await getStoredActiveRotation();

    return {
      action: 'activateBestBalanced',

      sourceWeekKey,
      activeWeekKey,
      mode,
      topN,
      maxPerMacroFamily,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      trueMicroOnly: true,

      skipped: true,
      changed: false,
      empty: previousActive.microFamilyIds.length === 0,
      emptyReason: 'NO_LONG_TRUE_MICRO_FAMILY_FOUND',

      activeRotation: previousActive,
      active: previousActive,

      activatedCount: previousActive.microFamilyIds.length,
      activatedMicroCount: previousActive.microFamilyIds.length,
      activatedMacroCount: previousActive.macroFamilyIds.length,

      activeMicroFamilyIds: previousActive.microFamilyIds,
      activeMacroFamilyIds: previousActive.macroFamilyIds,

      bestLong: previousActive.bestLong,
      bestShort: null,
      missingSides: previousActive.missingSides || [],

      perf: {
        durationMs: elapsed(startedAt),
        source: 'long_only_findBestWeekLongRows',
        weekRowsCacheHit: sideResult.weekRowsCacheHit,
        weekRowsCacheKey: sideResult.weekRowsCacheKey,
        scannedRows: sideResult.scannedRows,
        primaryRows: sideResult.primaryRows,
        previousRows: sideResult.previousRows,
        mergedPreviousWeek: sideResult.mergedPreviousWeek
      }
    };
  }

  const indexes = buildSelectionIndexes(microFamilies);

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_long_balanced`),

    source: 'ADMIN_ACTIVATE_TOP_BALANCED_LONG_TRUE_MICROS',

    mode,
    sideMode: 'long_only',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    requestedTradeSide: TARGET_TRADE_SIDE,
    replacedSide: TARGET_TRADE_SIDE,

    empty: microFamilies.length === 0,
    emptyReason: microFamilies.length === 0
      ? 'NO_LONG_TRUE_MICRO_ROWS_ACTIVE'
      : null,

    topNPerSide: topN,
    maxPerMacroFamily,

    eligibleCount: sideResult.tradableCount,
    softEligibleCount: sideResult.softCount,
    observationEligibleCount: sideResult.observationCount,
    rankedCount: sideResult.candidateCount,
    allRankedCount: sideResult.sideCount,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,
    selectedTier: sideResult.selectedTier,

    selectedRow,

    usedSoftFallback: sideResult.selectedTier === 'SOFT',
    usedObservationFallback: sideResult.selectedTier === 'OBSERVATION',
    usedPreviousWeekMerge: Boolean(sideResult.mergedPreviousWeek)
  });

  return {
    action: 'activateBestBalanced',

    sourceWeekKey,
    activeWeekKey,
    mode,
    topN,
    maxPerMacroFamily,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    bestLong: active.bestLong,
    bestShort: null,
    missingSides: active.missingSides || [],

    empty: Boolean(active.empty),
    emptyReason: active.emptyReason || null,
    usedSoftFallback: Boolean(active.usedSoftFallback),
    usedObservationFallback: Boolean(active.usedObservationFallback),
    usedPreviousWeekMerge: Boolean(active.usedPreviousWeekMerge),

    perf: {
      durationMs: elapsed(startedAt),
      source: 'long_only_findBestWeekLongRows',
      weekRowsCacheHit: sideResult.weekRowsCacheHit,
      weekRowsCacheKey: sideResult.weekRowsCacheKey,
      scannedRows: sideResult.scannedRows,
      primaryRows: sideResult.primaryRows,
      previousRows: sideResult.previousRows,
      mergedPreviousWeek: sideResult.mergedPreviousWeek
    }
  };
}

async function activateBestSideMicro(body, forcedTradeSide = null, startedAt = now()) {
  const sourceWeekKey = firstValue(
    body.weekKey,
    getIsoWeekKey()
  );

  const activeWeekKey = firstValue(
    body.activeWeekKey,
    getIsoWeekKey()
  );

  const mode = normalizeMode(
    firstValue(body.mode, 'balanced'),
    'balanced'
  );

  const requestedTradeSide = forcedTradeSide || normalizeRequestedTradeSide(
    firstValue(
      body.tradeSide,
      firstValue(body.side, firstValue(body.direction, TARGET_TRADE_SIDE))
    )
  );

  assertLongOnlySide(requestedTradeSide);

  const previousActive = await getStoredActiveRotation();

  const topN = rotationTopN(body);
  const maxPerMacroFamily = rotationMaxPerMacroFamily(body);
  const minMergeRows = minPrimaryRowsForPreviousMerge(body);

  const sideResult = await findBestWeekLongRows({
    weekKey: sourceWeekKey,
    mode,
    topN,
    maxPerMacroFamily,
    minPrimaryRowsForMerge: minMergeRows,
    startedAt
  });

  const {
    best: selectedRow,
    selectedRows,
    sideCount,
    candidateCount,
    hardCount,
    softCount,
    observationCount,
    tradableCount,
    selectedTier,
    weekRowsCacheHit,
    weekRowsCacheKey,
    scannedRows
  } = sideResult;

  const combinedRows = sortRowsByMode(
    dedupeRows(selectedRows || []),
    mode
  ).map((row, index) => normalizeRotationRow(row, index)).filter(Boolean);

  if (!selectedRow || combinedRows.length === 0) {
    return {
      action: 'activateBestSideMicro',

      sourceWeekKey,
      activeWeekKey,
      mode,
      topN,
      maxPerMacroFamily,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      trueMicroOnly: true,

      requestedTradeSide: TARGET_TRADE_SIDE,
      preservedTradeSide: null,

      skipped: true,
      changed: false,
      empty: previousActive.microFamilyIds.length === 0,
      emptyReason: 'NO_LONG_TRUE_MICRO_FAMILY_FOUND',

      sideCount,
      candidateCount,
      hardCount,
      softCount,
      observationCount,
      tradableCount,
      selectedTier: null,

      activeRotation: previousActive,
      active: previousActive,

      activatedCount: previousActive.microFamilyIds.length,
      activatedMicroCount: previousActive.microFamilyIds.length,
      activatedMacroCount: previousActive.macroFamilyIds.length,

      activeMicroFamilyIds: previousActive.microFamilyIds,
      activeMacroFamilyIds: previousActive.macroFamilyIds,

      selectedMicroFamilyId: null,
      selectedMacroFamilyId: null,

      selectedRow: null,

      bestLong: previousActive.bestLong,
      bestShort: null,
      missingSides: previousActive.missingSides || [],

      perf: {
        durationMs: elapsed(startedAt),
        weekRowsCacheHit,
        weekRowsCacheKey,
        scannedRows,
        primaryRows: sideResult.primaryRows,
        previousRows: sideResult.previousRows,
        mergedPreviousWeek: sideResult.mergedPreviousWeek
      }
    };
  }

  const indexes = buildSelectionIndexes(combinedRows);

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_long_side`),

    source: 'ADMIN_ACTIVATE_TOP_LONG_TRUE_MICROS',

    mode,
    sideMode: 'long_only',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    requestedTradeSide: TARGET_TRADE_SIDE,
    preservedTradeSide: null,

    replacedSide: TARGET_TRADE_SIDE,
    preservedSide: null,

    empty: combinedRows.length === 0,
    emptyReason: combinedRows.length === 0
      ? 'NO_LONG_TRUE_MICRO_ROWS_ACTIVE'
      : null,

    topNPerSide: topN,
    maxPerMacroFamily,

    eligibleCount: tradableCount,
    softEligibleCount: softCount,
    observationEligibleCount: observationCount,
    rankedCount: candidateCount,
    allRankedCount: sideCount,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies: combinedRows,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,
    selectedTier,

    selectedRow,
    preservedOppositeRow: null,

    previousActiveMicroFamilyIds: previousActive.microFamilyIds,
    previousActiveMacroFamilyIds: previousActive.macroFamilyIds,

    usedSoftFallback: selectedTier === 'SOFT',
    usedObservationFallback: selectedTier === 'OBSERVATION',
    usedPreviousWeekMerge: Boolean(sideResult.mergedPreviousWeek)
  });

  return {
    action: 'activateBestSideMicro',

    sourceWeekKey,
    activeWeekKey,
    mode,
    topN,
    maxPerMacroFamily,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    requestedTradeSide: TARGET_TRADE_SIDE,
    preservedTradeSide: null,

    skipped: false,
    changed: true,

    sideCount,
    candidateCount,
    hardCount,
    softCount,
    observationCount,
    tradableCount,
    selectedTier,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    selectedMicroFamilyId: selectedRow.microFamilyId,
    selectedMacroFamilyId: selectedRow.macroFamilyId,

    selectedRow,
    preservedOppositeRow: null,

    bestLong: active.bestLong,
    bestShort: null,
    missingSides: active.missingSides || [],

    usedSoftFallback: Boolean(active.usedSoftFallback),
    usedObservationFallback: Boolean(active.usedObservationFallback),
    usedPreviousWeekMerge: Boolean(active.usedPreviousWeekMerge),

    perf: {
      durationMs: elapsed(startedAt),
      weekRowsCacheHit,
      weekRowsCacheKey,
      scannedRows,
      primaryRows: sideResult.primaryRows,
      previousRows: sideResult.previousRows,
      mergedPreviousWeek: sideResult.mergedPreviousWeek
    }
  };
}

async function activateSelected(body, forcedType = null, startedAt = now()) {
  const sourceWeekKey = firstValue(
    body.weekKey,
    getIsoWeekKey()
  );

  const activeWeekKey = firstValue(
    body.activeWeekKey,
    getIsoWeekKey()
  );

  const requested = selectedIdsFromBody(body);

  let microFamilyIds = requested.microFamilyIds;
  let macroFamilyIds = requested.macroFamilyIds;

  if (forcedType === 'micro') {
    microFamilyIds = requested.microFamilyIds;
    macroFamilyIds = [];
  }

  if (forcedType === 'macro') {
    microFamilyIds = [];
    macroFamilyIds = requested.macroFamilyIds.length
      ? requested.macroFamilyIds
      : requested.microFamilyIds.filter(isLongId);
  }

  if (forcedType === null && microFamilyIds.length === 0 && macroFamilyIds.length === 0) {
    macroFamilyIds = requested.microFamilyIds.filter(isLongId);
    microFamilyIds = requested.microFamilyIds;
  }

  const hasMicroIds = microFamilyIds.length > 0;
  const hasMacroIds = macroFamilyIds.length > 0;

  if (!hasMicroIds && !hasMacroIds) {
    const error = new Error(
      requested.ignoredShortIds.length > 0
        ? 'SHORT_DISABLED_LONG_ONLY'
        : 'LONG_MICRO_OR_MACRO_FAMILY_IDS_REQUIRED'
    );
    error.statusCode = 400;
    throw error;
  }

  const selectedResult = await buildSelectedRotationRows({
    weekKey: sourceWeekKey,
    microFamilyIds,
    macroFamilyIds,
    minPrimaryRowsForMerge: minPrimaryRowsForPreviousMerge(body),
    startedAt
  });

  const microFamilies = selectedResult.rows;
  const indexes = buildSelectionIndexes(microFamilies);

  const active = await persistActiveRotation({
    rotationId: randomId(`ROT_${sourceWeekKey}_long_selected`),

    source: forcedType === 'macro'
      ? 'ADMIN_ACTIVATE_SELECTED_LONG_MACRO_EXPANDED_TRUE_MICROS'
      : forcedType === 'micro'
        ? 'ADMIN_ACTIVATE_SELECTED_LONG_TRUE_MICROS'
        : 'ADMIN_ACTIVATE_SELECTED_LONG_TRUE_MICROS',

    mode: 'selected',
    sideMode: 'long_only',

    sourceWeekKey,
    activeWeekKey,

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    empty: microFamilies.length === 0,
    emptyReason: microFamilies.length === 0
      ? 'NO_SELECTED_LONG_TRUE_MICRO_IDS_MATCHED'
      : null,

    microFamilyIds: normalizeFamilyIds(
      microFamilyIds,
      indexes.microFamilyIds
    ).filter((id) => indexes.microFamilyIds.includes(id)),

    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: normalizeFamilyIds(
      macroFamilyIds,
      indexes.macroFamilyIds
    ).filter(isLongId),

    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    requestedMicroFamilyIds: microFamilyIds,
    requestedMacroFamilyIds: macroFamilyIds,
    ignoredRequestedIds: requested.ignoredShortIds.map((id) => ({
      id,
      reason: 'SHORT_DISABLED_LONG_ONLY'
    })),

    usedPreviousWeekMerge: Boolean(selectedResult.mergedPreviousWeek)
  });

  return {
    action: forcedType === 'macro'
      ? 'activateSelectedMacroFamilies'
      : forcedType === 'micro'
        ? 'activateSelectedMicroFamilies'
        : 'activateSelected',

    sourceWeekKey,
    activeWeekKey,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    activeRotation: active,
    active,

    activatedCount: active.microFamilyIds.length,
    activatedMicroCount: active.microFamilyIds.length,
    activatedMacroCount: active.macroFamilyIds.length,

    activeMicroFamilyIds: active.microFamilyIds,
    activeMacroFamilyIds: active.macroFamilyIds,

    bestLong: active.bestLong,
    bestShort: null,
    missingSides: active.missingSides || [],

    ignoredRequestedIds: active.ignoredRequestedIds || [],

    perf: {
      durationMs: elapsed(startedAt),
      weekRowsCacheHit: selectedResult.weekRowsCacheHit,
      weekRowsCacheKey: selectedResult.weekRowsCacheKey,
      scannedRows: selectedResult.scannedRows,
      microsCount: selectedResult.microsCount,
      primaryRows: selectedResult.primaryRows,
      previousRows: selectedResult.previousRows,
      mergedPreviousWeek: selectedResult.mergedPreviousWeek
    }
  };
}

async function handlePost(req, res) {
  const requestStartedAt = now();
  const body = await readBody(req);
  const action = String(body?.action || '').trim();

  if (!action) {
    return res.status(400).json({
      ok: false,
      reason: 'ACTION_REQUIRED',
      allowedActions: ALLOWED_ACTIONS,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      trueMicroOnly: true
    });
  }

  if (BLOCKED_SHORT_ACTIONS.has(action)) {
    return res.status(400).json({
      ok: false,
      reason: 'SHORT_DISABLED_LONG_ONLY',
      action,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      trueMicroOnly: true,

      allowedActions: ALLOWED_ACTIONS
    });
  }

  if (action === 'activateBestBalanced') {
    const result = await activateBestBalanced(body, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (
    action === 'activateBestSideMicro' ||
    action === 'activateBestSideMicroFamily'
  ) {
    const result = await activateBestSideMicro(body, null, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateBestLongMicroFamily') {
    const result = await activateBestSideMicro(body, TARGET_TRADE_SIDE, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelected') {
    const result = await activateSelected(body, null, requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelectedMicroFamilies') {
    const result = await activateSelected(body, 'micro', requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  if (action === 'activateSelectedMacroFamilies') {
    const result = await activateSelected(body, 'macro', requestStartedAt);

    return res.status(200).json({
      ok: true,
      ...result,
      serverTs: Date.now()
    });
  }

  return res.status(400).json({
    ok: false,
    reason: 'UNKNOWN_ACTION',
    action,
    allowedActions: ALLOWED_ACTIONS,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true
  });
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Rotation-Mode', 'long-only-true-micro-top-set');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-True-Micro-Only', 'true');

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res);
    }

    if (req.method === 'POST') {
      return await handlePost(req, res);
    }

    return methodNotAllowed(res);
  } catch (error) {
    const status = error.statusCode || 500;

    return res.status(status).json({
      ok: false,

      targetTradeSide: TARGET_TRADE_SIDE,
      dashboardSide: TARGET_DASHBOARD_SIDE,
      longOnly: true,
      shortDisabled: true,
      trueMicroOnly: true,

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}