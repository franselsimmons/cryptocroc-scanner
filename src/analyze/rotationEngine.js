// ================= FILE: src/analyze/rotationEngine.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, getJson, setJson } from '../redis.js';
import {
  getIsoWeekKey,
  getNextIsoWeekKey,
  getPreviousIsoWeekKey,
  randomId,
  safeNumber,
  sideToTradeSide
} from '../utils.js';
import { getWeekMicros, saveWeekMicros } from './analyzeEngine.js';
import { rankMicros, refreshStats } from './scoring.js';
import { sendWeeklyRotationReport } from '../discord/discord.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const ROTATION_SIDES = [TARGET_TRADE_SIDE];

const DEFAULT_TOP_N_PER_SIDE = 100;
const MAX_TOP_N_PER_SIDE = 160;
const DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE = 25;

function now() {
  return Date.now();
}

function uniqueStrings(values = []) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  )];
}

function normalizeSchema(value) {
  return String(value || '').trim().toUpperCase();
}

function schemaMeta() {
  const macroSchema = normalizeSchema(
    CONFIG.analyze?.macroSchema ||
    CONFIG.analyze?.legacySchema ||
    CONFIG.analyze?.schema ||
    'MF_V1'
  );

  const microSchema = normalizeSchema(
    CONFIG.analyze?.microSchema ||
    'MF_V2'
  );

  return {
    schema: normalizeSchema(CONFIG.analyze?.schema || microSchema),
    macroSchema,
    microSchema,
    strategyVersion: CONFIG.strategyVersion
  };
}

function minWeightedCompleted() {
  return safeNumber(CONFIG.rotation?.minWeightedCompleted, 5);
}

function topNPerSide() {
  const configured = Math.floor(Number(CONFIG.rotation?.topNPerSide || 0));
  const n = Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TOP_N_PER_SIDE;

  return Math.min(
    MAX_TOP_N_PER_SIDE,
    Math.max(DEFAULT_TOP_N_PER_SIDE, n)
  );
}

function maxPerMacroFamily() {
  if (CONFIG.rotation?.enforceMaxPerMacroFamily !== true) return 0;

  const n = Number(CONFIG.rotation?.maxPerMacroFamily || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : 0;
}

function minPrimaryRowsForPreviousMerge() {
  const n = Number(CONFIG.rotation?.minPrimaryRowsForPreviousMerge || 0);

  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : DEFAULT_MIN_PRIMARY_ROWS_FOR_PREVIOUS_MERGE;
}

function defaultRotationMode() {
  return CONFIG.rotation?.mode || 'balanced';
}

function allowLegacyMacroActivation() {
  return false;
}

function allowManualUnknownTrueMicroIds() {
  return CONFIG.rotation?.allowManualUnknownTrueMicroIds !== false;
}

function allowManualBelowMinCompleted() {
  return Boolean(CONFIG.rotation?.allowManualBelowMinCompleted);
}

function allowSoftRotationFallback() {
  return CONFIG.rotation?.allowSoftRotationFallback !== false;
}

function allowObservationRotationFallback() {
  return CONFIG.rotation?.allowObservationRotationFallback !== false;
}

function allowRawRotationFallback() {
  return CONFIG.rotation?.allowRawRotationFallback !== false;
}

function rowId(row = {}) {
  return String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).toUpperCase();
}

function idLooksLikeMicroFamily(id = '') {
  return String(id || '').toUpperCase().startsWith('MICRO_');
}

function idLooksLikeLongFamily(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.includes('LONG') ||
    value.includes('BULL') ||
    value.includes('BUY') ||
    value.includes('TRADESIDE=LONG') ||
    value.includes('TRADE_SIDE=LONG') ||
    value.includes('SIDE=LONG') ||
    value.includes('SIDE=BULL')
  );
}

function idLooksLikeShortFamily(id = '') {
  const value = String(id || '').toUpperCase();

  return (
    value.includes('SHORT') ||
    value.includes('BEAR') ||
    value.includes('SELL') ||
    value.includes('TRADESIDE=SHORT') ||
    value.includes('TRADE_SIDE=SHORT') ||
    value.includes('SIDE=SHORT') ||
    value.includes('SIDE=BEAR')
  );
}

function idLooksLikeSimpleMacroFamily(id = '') {
  return /^LONG_\d+$/i.test(String(id || '').trim());
}

function hasSchemaInId(id, schema) {
  const s = normalizeSchema(schema);
  const value = String(id || '').toUpperCase();

  if (!s) return false;

  return (
    value.includes(`_${s}_`) ||
    value.endsWith(`_${s}`) ||
    value.includes(`|SCHEMA=${s}`) ||
    value.includes(`SCHEMA=${s}`)
  );
}

function definitionHasSchema(row = {}, schema) {
  const s = normalizeSchema(schema);

  if (!s) return false;

  const parts = [
    ...(Array.isArray(row.definitionParts) ? row.definitionParts : []),
    ...(Array.isArray(row.microDefinitionParts) ? row.microDefinitionParts : []),
    ...(Array.isArray(row.macroDefinitionParts) ? row.macroDefinitionParts : []),
    ...(Array.isArray(row.parentDefinitionParts) ? row.parentDefinitionParts : [])
  ];

  if (parts.some((part) => String(part).toUpperCase() === `SCHEMA=${s}`)) {
    return true;
  }

  const text = [
    row.definition,
    row.microDefinition,
    row.macroDefinition,
    row.parentDefinition
  ]
    .map((value) => String(value || '').toUpperCase())
    .join('|');

  return text.includes(`SCHEMA=${s}`);
}

function rowSchema(row = {}) {
  return normalizeSchema(
    row.microFamilySchema ||
    row.schema ||
    row.versionSchema ||
    ''
  );
}

function hasParentMacro(row = {}) {
  return Boolean(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId
  );
}

function parentMacroFamilyId(row = {}) {
  const direct = String(
    row.parentMacroFamilyId ||
    row.parentMicroFamilyId ||
    row.macroFamilyId ||
    ''
  ).trim();

  if (direct) return direct;

  const familyId = String(row.familyId || '').trim();

  if (familyId) return familyId;

  const id = String(
    row.microFamilyId ||
    row.trueMicroFamilyId ||
    row.id ||
    row.key ||
    ''
  ).trim();

  if (idLooksLikeSimpleMacroFamily(id)) return id;

  return '';
}

function definitionSide(row = {}) {
  const definition = [
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
    .join('|');

  if (
    definition.includes('TRADESIDE=SHORT') ||
    definition.includes('TRADE_SIDE=SHORT') ||
    definition.includes('SIDE=SHORT') ||
    definition.includes('SIDE=BEAR') ||
    definition.includes('DIRECTION=SHORT') ||
    definition.includes('DIRECTION=BEAR') ||
    definition.includes('SIDE=SELL') ||
    definition.includes('DIRECTION=SELL')
  ) {
    return 'SHORT';
  }

  if (
    definition.includes('TRADESIDE=LONG') ||
    definition.includes('TRADE_SIDE=LONG') ||
    definition.includes('SIDE=LONG') ||
    definition.includes('SIDE=BULL') ||
    definition.includes('DIRECTION=LONG') ||
    definition.includes('DIRECTION=BULL') ||
    definition.includes('SIDE=BUY') ||
    definition.includes('DIRECTION=BUY')
  ) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function microSide(row = {}) {
  const direct = sideToTradeSide(
    row.tradeSide ||
    row.side ||
    row.positionSide ||
    row.direction ||
    row.signalSide ||
    row.scannerSide ||
    row.entrySide
  );

  if (direct === 'SHORT') return 'SHORT';
  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  const familyId = String(row.familyId || '').toUpperCase();
  const macroId = String(parentMacroFamilyId(row) || '').toUpperCase();
  const microId = rowId(row);

  if (familyId.startsWith('SHORT_')) return 'SHORT';
  if (idLooksLikeShortFamily(macroId)) return 'SHORT';
  if (idLooksLikeShortFamily(microId)) return 'SHORT';

  const fromDefinition = definitionSide(row);

  if (fromDefinition === 'SHORT') return 'SHORT';
  if (fromDefinition === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;

  if (familyId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (macroId.startsWith('LONG_')) return TARGET_TRADE_SIDE;
  if (idLooksLikeLongFamily(macroId)) return TARGET_TRADE_SIDE;
  if (idLooksLikeLongFamily(microId)) return TARGET_TRADE_SIDE;

  if (row.longOnly === true || row.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function normalizedSide(row = {}) {
  const side = microSide(row);

  if (side === TARGET_TRADE_SIDE) return TARGET_DASHBOARD_SIDE;

  return 'unknown';
}

function isLongRotationRow(row = {}) {
  return microSide(row) === TARGET_TRADE_SIDE;
}

export function isTrueMicroFamily(row = {}) {
  const { microSchema, macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (microSide(row) === 'SHORT') return false;

  if (row.isLegacyMacro === true) return false;
  if (idLooksLikeSimpleMacroFamily(id)) return false;
  if (version.includes('MACRO')) return false;
  if (schema === macroSchema) return false;
  if (hasSchemaInId(id, macroSchema)) return false;
  if (definitionHasSchema(row, macroSchema)) return false;

  if (row.trueMicro === true || row.isTrueMicro === true) return true;
  if (version.includes('MICRO')) return true;
  if (schema === microSchema) return true;
  if (hasSchemaInId(id, microSchema)) return true;
  if (definitionHasSchema(row, microSchema)) return true;

  if (hasParentMacro(row) && idLooksLikeMicroFamily(id)) return true;

  return false;
}

export function isLegacyMacroFamily(row = {}) {
  const { macroSchema } = schemaMeta();

  const id = rowId(row);
  const schema = rowSchema(row);
  const version = String(row.version || '').toUpperCase();

  if (!row || !id) return false;
  if (microSide(row) === 'SHORT') return false;
  if (isTrueMicroFamily(row)) return false;

  if (row.isLegacyMacro === true) return true;
  if (version.includes('MACRO')) return true;
  if (idLooksLikeSimpleMacroFamily(id)) return true;
  if (schema === macroSchema) return true;
  if (hasSchemaInId(id, macroSchema)) return true;
  if (definitionHasSchema(row, macroSchema)) return true;

  return !row.parentMacroFamilyId && !row.parentMicroFamilyId;
}

function isKnownTrueMicroId(id = '') {
  const { microSchema, macroSchema } = schemaMeta();
  const value = String(id || '').toUpperCase();

  if (!value) return false;
  if (!idLooksLikeLongFamily(value)) return false;
  if (!idLooksLikeMicroFamily(value)) return false;
  if (hasSchemaInId(value, macroSchema)) return false;

  return hasSchemaInId(value, microSchema);
}

function isEligible(row = {}) {
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  return safeNumber(row.completed, 0) >= minWeightedCompleted();
}

function isSoftEligible(row = {}) {
  if (!allowSoftRotationFallback()) return false;
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const completed = safeNumber(row.completed, 0);
  const balancedScore = safeNumber(
    row.dashboardBalancedScore ?? row.balancedScore,
    0
  );

  if (completed <= 0) return false;
  if (balancedScore <= 0) return false;

  return (
    safeNumber(row.avgR, 0) > 0 ||
    safeNumber(row.totalR, 0) > 0 ||
    safeNumber(row.fairWinrate, 0) > 0 ||
    safeNumber(row.sampleAdjustedWinrate, 0) > 0 ||
    safeNumber(row.wilsonLowerBound, 0) > 0 ||
    safeNumber(row.sampleWilsonLowerBound, 0) > 0
  );
}

function isObservationEligible(row = {}) {
  if (!allowObservationRotationFallback()) return false;
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  const seen = safeNumber(row.seen, 0);
  const observations = safeNumber(row.observations, 0);
  const winrateSample = safeNumber(row.winrateSample, 0);
  const completed = safeNumber(row.completed, 0);

  return Math.max(seen, observations, winrateSample, completed) > 0;
}

function rotationEligibilityTier(row = {}) {
  if (isEligible(row)) return 'HARD';
  if (isSoftEligible(row)) return 'SOFT';
  if (isObservationEligible(row)) return 'OBSERVATION';

  return 'NONE';
}

function isManualEligible(row = {}) {
  if (!isLongRotationRow(row)) return false;
  if (!isTrueMicroFamily(row)) return false;

  if (allowManualBelowMinCompleted()) return true;

  return isEligible(row) || isSoftEligible(row) || isObservationEligible(row);
}

function compactRotationRow(row = {}, rank = 0) {
  const refreshed = refreshStats(row);
  const side = normalizedSide(refreshed);
  const tradeSide = microSide(refreshed);
  const macroId = parentMacroFamilyId(refreshed);
  const eligibilityTier = rotationEligibilityTier(refreshed);
  const meta = schemaMeta();

  return {
    rank,

    microFamilyId: refreshed.microFamilyId || refreshed.trueMicroFamilyId || refreshed.id || null,
    trueMicroFamilyId: refreshed.microFamilyId || refreshed.trueMicroFamilyId || refreshed.id || null,
    familyId: refreshed.familyId || null,

    macroFamilyId: macroId || refreshed.macroFamilyId || null,
    parentMacroFamilyId: macroId || null,
    parentMicroFamilyId: refreshed.parentMicroFamilyId || macroId || null,

    side,
    tradeSide,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    schema: refreshed.schema || refreshed.microFamilySchema || meta.microSchema,
    microFamilySchema: refreshed.microFamilySchema || refreshed.schema || meta.microSchema,
    version: refreshed.version || 'micro',

    isTrueMicro: isTrueMicroFamily(refreshed),
    isLegacyMacro: isLegacyMacroFamily(refreshed),

    rotationEligibilityTier: eligibilityTier,
    rotationEligible: eligibilityTier !== 'NONE',
    hardEligible: eligibilityTier === 'HARD',
    softEligible: eligibilityTier === 'SOFT',
    observationEligible: eligibilityTier === 'OBSERVATION',

    seen: safeNumber(refreshed.seen, 0),
    observations: safeNumber(refreshed.observations ?? refreshed.seen, 0),

    completed: safeNumber(refreshed.completed, 0),
    realCompleted: safeNumber(refreshed.realCompleted, 0),
    shadowCompleted: safeNumber(refreshed.shadowCompleted, 0),

    winrateSample: safeNumber(refreshed.winrateSample ?? refreshed.completed, 0),
    winrate: safeNumber(refreshed.winrate, 0),
    bayesianWinrate: safeNumber(refreshed.bayesianWinrate, 0),
    wilsonLowerBound: safeNumber(refreshed.wilsonLowerBound, 0),
    sampleWilsonLowerBound: safeNumber(
      refreshed.sampleWilsonLowerBound ?? refreshed.wilsonLowerBound,
      0
    ),
    fairWinrate: safeNumber(refreshed.fairWinrate, 0),
    sampleAdjustedWinrate: safeNumber(refreshed.sampleAdjustedWinrate, 0),
    sampleReliability: safeNumber(refreshed.sampleReliability, 0),

    avgR: safeNumber(refreshed.avgR, 0),
    totalR: safeNumber(refreshed.totalR, 0),
    avgWinR: safeNumber(refreshed.avgWinR, 0),
    avgLossR: safeNumber(refreshed.avgLossR, 0),

    profitFactor: safeNumber(refreshed.profitFactor, 0),
    directSLPct: safeNumber(refreshed.directSLPct, 0),
    nearTpPct: safeNumber(refreshed.nearTpPct, 0),
    reachedHalfRPct: safeNumber(refreshed.reachedHalfRPct, 0),
    reachedOneRPct: safeNumber(refreshed.reachedOneRPct, 0),

    beWouldExitPct: safeNumber(refreshed.beWouldExitPct, 0),
    gaveBackAfterHalfRPct: safeNumber(refreshed.gaveBackAfterHalfRPct, 0),
    gaveBackAfterOneRPct: safeNumber(refreshed.gaveBackAfterOneRPct, 0),
    nearTpThenLossPct: safeNumber(refreshed.nearTpThenLossPct, 0),

    totalCostR: safeNumber(refreshed.totalCostR, 0),
    avgCostR: safeNumber(refreshed.avgCostR, 0),

    balancedScore: safeNumber(refreshed.balancedScore, 0),
    dashboardBalancedScore: safeNumber(
      refreshed.dashboardBalancedScore ?? refreshed.balancedScore,
      0
    ),

    assetClass: refreshed.assetClass || null,

    rsiZone: refreshed.rsiZone || null,
    rsiCoarse: refreshed.rsiCoarse || null,

    flow: refreshed.flow || null,
    flowCoarse: refreshed.flowCoarse || null,

    obRelation: refreshed.obRelation || null,

    btcState: refreshed.btcState || null,
    btcRelation: refreshed.btcRelation || null,

    regime: refreshed.regime || null,
    regimeCoarse: refreshed.regimeCoarse || null,

    scannerReason: refreshed.scannerReason || null,
    scannerReasonCoarse: refreshed.scannerReasonCoarse || null,

    definitionParts: Array.isArray(refreshed.definitionParts)
      ? refreshed.definitionParts
      : [],

    definition: refreshed.definition || '',

    parentDefinitionParts: Array.isArray(refreshed.parentDefinitionParts)
      ? refreshed.parentDefinitionParts
      : [],

    parentDefinition: refreshed.parentDefinition || '',

    counters: refreshed.counters || {},
    examples: Array.isArray(refreshed.examples)
      ? refreshed.examples.slice(0, 20)
      : [],

    recentOutcomes: Array.isArray(refreshed.recentOutcomes)
      ? refreshed.recentOutcomes.slice(0, 20)
      : []
  };
}

function canUseMacroSlot({
  row,
  countsByMacro
}) {
  const macroCap = maxPerMacroFamily();

  if (macroCap <= 0) return true;

  const macroId = parentMacroFamilyId(row);

  if (!macroId) return true;

  return safeNumber(countsByMacro[macroId], 0) < macroCap;
}

function reserveMacroSlot({
  row,
  countsByMacro
}) {
  const macroId = parentMacroFamilyId(row);

  if (!macroId) return;

  countsByMacro[macroId] = safeNumber(countsByMacro[macroId], 0) + 1;
}

function addSelectedRow({
  row,
  selected,
  selectedIds,
  countsBySide,
  countsByMacro
}) {
  const id = String(row?.microFamilyId || row?.trueMicroFamilyId || row?.id || '').trim();
  const side = microSide(row);

  if (!id) return false;
  if (selectedIds.has(id)) return false;
  if (side !== TARGET_TRADE_SIDE) return false;
  if (!isTrueMicroFamily(row)) return false;
  if (!canUseMacroSlot({ row, countsByMacro })) return false;

  selectedIds.add(id);
  countsBySide[TARGET_TRADE_SIDE] = safeNumber(countsBySide[TARGET_TRADE_SIDE], 0) + 1;
  reserveMacroSlot({ row, countsByMacro });

  selected.push({
    ...row,
    microFamilyId: id,
    trueMicroFamilyId: id
  });

  return true;
}

function buildSelectionState(existing = []) {
  const selected = [];
  const selectedIds = new Set();
  const countsBySide = {
    [TARGET_TRADE_SIDE]: 0
  };
  const countsByMacro = {};

  for (const row of existing) {
    addSelectedRow({
      row,
      selected,
      selectedIds,
      countsBySide,
      countsByMacro
    });
  }

  return {
    selected,
    selectedIds,
    countsBySide,
    countsByMacro
  };
}

function appendRowsToSelection({
  state,
  rows = [],
  targetCount = topNPerSide()
}) {
  for (const row of rows) {
    if (state.countsBySide[TARGET_TRADE_SIDE] >= targetCount) break;

    addSelectedRow({
      row,
      selected: state.selected,
      selectedIds: state.selectedIds,
      countsBySide: state.countsBySide,
      countsByMacro: state.countsByMacro
    });
  }

  return state.selected;
}

function selectTopPerSide(ranked, topN, existing = []) {
  const safeTopN = Math.max(1, Number(topN) || DEFAULT_TOP_N_PER_SIDE);
  const state = buildSelectionState(existing);

  appendRowsToSelection({
    state,
    rows: ranked,
    targetCount: safeTopN
  });

  return state.selected;
}

function hasSelectedSide(rows = [], side) {
  return rows.some((row) => microSide(row) === side);
}

function missingSides(rows = []) {
  return ROTATION_SIDES.filter((side) => !hasSelectedSide(rows, side));
}

function selectRotationCandidates(rankedCandidates = []) {
  const trueLongCandidates = rankedCandidates
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily);

  const hardEligible = trueLongCandidates.filter(isEligible);
  const softEligible = trueLongCandidates
    .filter((row) => !isEligible(row))
    .filter(isSoftEligible);

  const observationEligible = trueLongCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter(isObservationEligible);

  const rawFallback = trueLongCandidates
    .filter((row) => !isEligible(row))
    .filter((row) => !isSoftEligible(row))
    .filter((row) => !isObservationEligible(row));

  const targetCount = topNPerSide();
  const state = buildSelectionState();

  appendRowsToSelection({
    state,
    rows: hardEligible,
    targetCount
  });

  if (allowSoftRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: softEligible,
      targetCount
    });
  }

  if (allowObservationRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: observationEligible,
      targetCount
    });
  }

  if (state.selected.length === 0 && allowRawRotationFallback()) {
    appendRowsToSelection({
      state,
      rows: rawFallback,
      targetCount
    });
  }

  return {
    selected: state.selected,
    eligible: hardEligible,
    softEligible,
    observationEligible,
    rawFallback,

    usedSoftFallback: state.selected.some((row) => !isEligible(row) && isSoftEligible(row)),
    usedObservationFallback: state.selected.some((row) => !isEligible(row) && !isSoftEligible(row) && isObservationEligible(row)),
    usedRawFallback: state.selected.some((row) => rotationEligibilityTier(row) === 'NONE'),

    missingSides: missingSides(state.selected)
  };
}

function filterRankedRows(rows = [], filter = 'trueMicro') {
  const longRows = rows.filter(isLongRotationRow);

  if (filter === 'all') return longRows;
  if (filter === 'legacyMacro') return longRows.filter(isLegacyMacroFamily);

  return longRows.filter(isTrueMicroFamily);
}

function buildRankings(micros, { filter = 'trueMicro' } = {}) {
  const modes = [
    'balanced',
    'winrate',
    'totalR',
    'avgR',
    'directSL',
    'observed'
  ];

  return Object.fromEntries(
    modes.map((mode) => {
      const rows = filterRankedRows(rankMicros(micros, mode), filter)
        .slice(0, MAX_TOP_N_PER_SIDE)
        .map((row, index) => compactRotationRow(row, index + 1));

      return [mode, rows];
    })
  );
}

function buildSelectionIndexes(microFamilies = []) {
  const longRows = microFamilies
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily);

  const microFamilyIds = uniqueStrings(
    longRows.map((row) => row.microFamilyId)
  );

  const macroFamilyIds = uniqueStrings(
    longRows.map((row) => (
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId
    ))
  );

  const microToMacroFamilyId = {};
  const macroToMicroFamilyIds = {};

  for (const row of longRows) {
    const microId = String(row.microFamilyId || '').trim();
    const macroId = String(
      row.parentMacroFamilyId ||
      row.parentMicroFamilyId ||
      row.macroFamilyId ||
      ''
    ).trim();

    if (!microId || !macroId) continue;

    microToMacroFamilyId[microId] = macroId;

    if (!macroToMicroFamilyIds[macroId]) {
      macroToMicroFamilyIds[macroId] = [];
    }

    macroToMicroFamilyIds[macroId].push(microId);
  }

  for (const macroId of Object.keys(macroToMicroFamilyIds)) {
    macroToMicroFamilyIds[macroId] = uniqueStrings(
      macroToMicroFamilyIds[macroId]
    );
  }

  return {
    microFamilyIds,
    activeMicroFamilyIds: microFamilyIds,
    trueMicroFamilyIds: microFamilyIds,

    macroFamilyIds,
    activeMacroFamilyIds: macroFamilyIds,

    microToMacroFamilyId,
    macroToMicroFamilyIds
  };
}

function countByPredicate(micros = {}, predicate) {
  return Object.values(micros || {}).filter(predicate).length;
}

function bestLongRow(rows = []) {
  return rows.find((row) => microSide(row) === TARGET_TRADE_SIDE) || null;
}

function mergeMicros(primary = {}, fallback = {}) {
  return {
    ...(fallback || {}),
    ...(primary || {})
  };
}

async function getRotationMicros(weekKey = getIsoWeekKey()) {
  const primary = await getWeekMicros(weekKey);
  const primaryRows = Object.keys(primary || {}).length;

  const previousWeekKey = getPreviousIsoWeekKey();
  const shouldMergePrevious =
    weekKey !== previousWeekKey &&
    primaryRows < minPrimaryRowsForPreviousMerge();

  if (!shouldMergePrevious) {
    return {
      micros: primary || {},
      primaryWeekKey: weekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false
    };
  }

  const previous = await getWeekMicros(previousWeekKey).catch(() => ({}));
  const previousRows = Object.keys(previous || {}).length;

  if (previousRows <= 0) {
    return {
      micros: primary || {},
      primaryWeekKey: weekKey,
      previousWeekKey,
      primaryRows,
      previousRows: 0,
      usedPreviousWeekMerge: false
    };
  }

  return {
    micros: mergeMicros(primary, previous),
    primaryWeekKey: weekKey,
    previousWeekKey,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge: true
  };
}

function buildEmptyRotation({
  weekKey,
  activeWeekKey,
  mode,
  micros,
  ranked,
  eligible,
  softEligible = [],
  observationEligible = [],
  rawFallback = [],
  usedPreviousWeekMerge = false,
  primaryRows = 0,
  previousRows = 0,
  emptyReason = 'NO_LONG_TRUE_MICRO_FAMILIES_MET_MIN_WEIGHTED_COMPLETED'
}) {
  const indexes = buildSelectionIndexes([]);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_long_only`),
    source: 'ANALYZE_WEEKLY_RANKING_LONG_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback: false,
    usedObservationFallback: false,
    usedRawFallback: false,
    usedPreviousWeekMerge,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible?.length || 0,
    softEligibleCount: softEligible?.length || 0,
    observationEligibleCount: observationEligible?.length || 0,
    rawFallbackCount: rawFallback?.length || 0,
    rankedCount: ranked.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isLongRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isLongRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: [TARGET_TRADE_SIDE],

    empty: true,
    emptyReason,

    bestLong: null,
    bestShort: null,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies: [],

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function buildRotationFromWeek({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const {
    micros,
    primaryRows,
    previousRows,
    usedPreviousWeekMerge
  } = await getRotationMicros(weekKey);

  const rankedAll = rankMicros(micros, mode)
    .filter(isLongRotationRow);

  const rankedTrueMicros = rankedAll
    .filter(isTrueMicroFamily);

  const rankedCandidates = rankedTrueMicros;

  const {
    selected,
    eligible,
    softEligible,
    observationEligible,
    rawFallback,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    missingSides: selectedMissingSides
  } = selectRotationCandidates(rankedCandidates);

  if (selected.length === 0) {
    return buildEmptyRotation({
      weekKey,
      activeWeekKey,
      mode,
      micros,
      ranked: rankedCandidates,
      eligible,
      softEligible,
      observationEligible,
      rawFallback,
      usedPreviousWeekMerge,
      primaryRows,
      previousRows,
      emptyReason: rankedTrueMicros.length === 0
        ? 'NO_LONG_TRUE_MICRO_FAMILIES_FOUND'
        : 'NO_LONG_TRUE_MICRO_FAMILIES_AVAILABLE_FOR_ROTATION'
    });
  }

  const microFamilies = selected
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId);

  const indexes = buildSelectionIndexes(microFamilies);

  return {
    rotationId: randomId(`ROT_${weekKey}_${mode}_long_only`),
    source: 'ANALYZE_WEEKLY_RANKING_LONG_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey,

    generatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,
    usedLegacyFallback: false,
    usedSoftFallback,
    usedObservationFallback,
    usedRawFallback,
    usedPreviousWeekMerge,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    eligibleCount: eligible.length,
    softEligibleCount: softEligible.length,
    observationEligibleCount: observationEligible.length,
    rawFallbackCount: rawFallback.length,
    rankedCount: rankedCandidates.length,
    allRankedCount: rankedAll.length,
    microCount: Object.keys(micros || {}).length,
    trueMicroCount: countByPredicate(micros, (row) => isTrueMicroFamily(row) && isLongRotationRow(row)),
    legacyMacroCount: countByPredicate(micros, (row) => isLegacyMacroFamily(row) && isLongRotationRow(row)),

    primaryRows,
    previousRows,

    missingSides: selectedMissingSides,

    empty: false,
    emptyReason: null,

    bestLong: bestLongRow(microFamilies),
    bestShort: null,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies,

    rankings: buildRankings(micros, { filter: 'trueMicro' }),
    macroRankings: buildRankings(micros, { filter: 'legacyMacro' }),
    allRankings: buildRankings(micros, { filter: 'all' })
  };
}

export async function freezeWeeklyRotation({
  weekKey = getIsoWeekKey(),
  activeWeekKey = getNextIsoWeekKey(),
  mode = defaultRotationMode()
} = {}) {
  const redis = getDurableRedis();

  const micros = await getWeekMicros(weekKey);

  await saveWeekMicros(weekKey, micros);

  const rotation = await buildRotationFromWeek({
    weekKey,
    activeWeekKey,
    mode
  });

  await setJson(
    redis,
    KEYS.analyze.nextRotation,
    rotation
  );

  await setJson(
    redis,
    KEYS.analyze.rotationValidFrom,
    {
      validFrom: `${activeWeekKey}_MONDAY_00_UTC`,
      ts: now(),
      sourceWeekKey: weekKey,
      activeWeekKey,
      rotationId: rotation.rotationId,

      targetTradeSide: TARGET_TRADE_SIDE,
      longOnly: true,
      shortDisabled: true,
      trueMicroOnly: true,

      usedLegacyFallback: false,
      usedSoftFallback: rotation.usedSoftFallback,
      usedObservationFallback: rotation.usedObservationFallback,
      usedRawFallback: rotation.usedRawFallback,
      usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,

      selectedMicroFamilies: rotation.microFamilyIds.length,
      selectedMacroFamilies: rotation.macroFamilyIds.length,
      missingSides: rotation.missingSides || [],
      bestLong: rotation.bestLong?.microFamilyId || null,
      bestShort: null
    }
  );

  await sendWeeklyRotationReport(
    rotation,
    'NEXT_ROTATION_READY'
  ).catch(() => null);

  return {
    ok: true,
    type: 'NEXT_ROTATION_READY',
    weekKey,
    activeWeekKey,
    mode,
    rotationId: rotation.rotationId,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    selectedMicroFamilies: rotation.microFamilyIds.length,
    selectedMacroFamilies: rotation.macroFamilyIds.length,

    usedLegacyFallback: false,
    usedSoftFallback: rotation.usedSoftFallback,
    usedObservationFallback: rotation.usedObservationFallback,
    usedRawFallback: rotation.usedRawFallback,
    usedPreviousWeekMerge: rotation.usedPreviousWeekMerge,

    missingSides: rotation.missingSides || [],
    bestLong: rotation.bestLong,
    bestShort: null,
    rotation
  };
}

function sanitizeActiveRotation(rotation = {}) {
  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
    : [];

  const longRows = rows
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => compactRotationRow(row, index + 1))
    .filter((row) => row.microFamilyId);

  const indexes = buildSelectionIndexes(longRows);

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    usedLegacyFallback: false,

    microFamilies: longRows,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    bestLong: bestLongRow(longRows),
    bestShort: null,
    missingSides: missingSides(longRows),

    empty: longRows.length === 0,
    emptyReason: longRows.length === 0
      ? 'ACTIVE_ROTATION_CONTAINED_NO_LONG_TRUE_MICRO_FAMILIES'
      : rotation.emptyReason || null
  };
}

export async function activateNextRotation() {
  const redis = getDurableRedis();

  const next = await getJson(
    redis,
    KEYS.analyze.nextRotation,
    null
  );

  if (!next) {
    return {
      ok: false,
      reason: 'NEXT_ROTATION_MISSING'
    };
  }

  const active = sanitizeActiveRotation({
    ...next,
    source: 'ANALYZE_NEXT_ROTATION_ACTIVATED_LONG_TRUE_MICRO_ONLY',
    activatedAt: now()
  });

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    active
  );

  await sendWeeklyRotationReport(
    active,
    'ACTIVE_ROTATION_ACTIVATED'
  ).catch(() => null);

  return {
    ok: true,
    activeRotation: active,
    rotationId: active.rotationId,
    activatedCount: active.microFamilyIds?.length || 0,
    activatedMicroCount: active.microFamilyIds?.length || 0,
    activatedMacroCount: active.macroFamilyIds?.length || 0,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    usedSoftFallback: active.usedSoftFallback,
    usedObservationFallback: active.usedObservationFallback,
    usedRawFallback: active.usedRawFallback,
    usedPreviousWeekMerge: active.usedPreviousWeekMerge,

    missingSides: active.missingSides || [],
    bestLong: active.bestLong,
    bestShort: null
  };
}

export async function getActiveRotation() {
  const redis = getDurableRedis();

  return await getJson(
    redis,
    KEYS.analyze.activeRotation,
    null
  );
}

export async function getActiveRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings(
    active?.activeMicroFamilyIds ||
    active?.trueMicroFamilyIds ||
    active?.microFamilyIds ||
    []
  )
    .filter(isKnownTrueMicroId)
    .filter(idLooksLikeLongFamily);

  return new Set(ids);
}

export async function getActiveMacroRotationSet() {
  const active = await getActiveRotation();

  const ids = uniqueStrings(
    active?.activeMacroFamilyIds ||
    active?.macroFamilyIds ||
    []
  ).filter(idLooksLikeLongFamily);

  return new Set(ids);
}

function getChildrenForMacroId({ micros = {}, macroId, mode = 'balanced' }) {
  const id = String(macroId || '').trim();

  if (!id) return [];
  if (!idLooksLikeLongFamily(id)) return [];

  return rankMicros(micros, mode)
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .filter((row) => parentMacroFamilyId(row) === id);
}

function manualSideFromId(id = '') {
  const value = String(id || '').toUpperCase();

  if (idLooksLikeShortFamily(value)) return 'SHORT';
  if (idLooksLikeLongFamily(value)) return TARGET_TRADE_SIDE;

  return 'UNKNOWN';
}

function buildManualOnlyRow(id, rank) {
  const tradeSide = manualSideFromId(id);

  if (tradeSide !== TARGET_TRADE_SIDE) return null;
  if (!isKnownTrueMicroId(id)) return null;

  return {
    rank,

    microFamilyId: id,
    trueMicroFamilyId: id,
    familyId: null,

    macroFamilyId: null,
    parentMacroFamilyId: null,
    parentMicroFamilyId: null,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    schema: schemaMeta().microSchema,
    microFamilySchema: schemaMeta().microSchema,
    version: 'manual_true_micro',

    isTrueMicro: true,
    isLegacyMacro: false,
    manualOnly: true,
    unverifiedManualId: true,

    rotationEligibilityTier: 'MANUAL',
    rotationEligible: true,
    hardEligible: false,
    softEligible: false,
    observationEligible: false,

    seen: 0,
    observations: 0,

    completed: 0,
    realCompleted: 0,
    shadowCompleted: 0,

    winrateSample: 0,
    winrate: 0,
    bayesianWinrate: 0,
    wilsonLowerBound: 0,
    sampleWilsonLowerBound: 0,
    fairWinrate: 0,
    sampleAdjustedWinrate: 0,
    sampleReliability: 0,

    avgR: 0,
    totalR: 0,
    avgWinR: 0,
    avgLossR: 0,

    profitFactor: 0,
    directSLPct: 0,
    nearTpPct: 0,
    reachedHalfRPct: 0,
    reachedOneRPct: 0,

    beWouldExitPct: 0,
    gaveBackAfterHalfRPct: 0,
    gaveBackAfterOneRPct: 0,
    nearTpThenLossPct: 0,

    totalCostR: 0,
    avgCostR: 0,

    balancedScore: 0,
    dashboardBalancedScore: 0,

    definitionParts: [],
    definition: '',

    parentDefinitionParts: [],
    parentDefinition: ''
  };
}

function resolveManualSelection({
  requestedIds = [],
  micros = {},
  mode = 'manual'
}) {
  const selectedRows = [];
  const ignoredIds = [];
  const expandedFromMacro = {};
  const seen = new Set();

  const microsByUpperId = Object.fromEntries(
    Object.values(micros || {})
      .filter(Boolean)
      .map((row) => [
        String(row.microFamilyId || row.trueMicroFamilyId || row.id || '').toUpperCase(),
        row
      ])
      .filter(([id]) => Boolean(id))
  );

  const addRow = (row) => {
    const id = String(row?.microFamilyId || row?.trueMicroFamilyId || row?.id || '').trim();

    if (!id || seen.has(id)) return;
    if (!isLongRotationRow(row)) return;
    if (!isTrueMicroFamily(row)) return;

    seen.add(id);
    selectedRows.push({
      ...row,
      microFamilyId: id,
      trueMicroFamilyId: id
    });
  };

  for (const id of requestedIds) {
    if (!idLooksLikeLongFamily(id) || idLooksLikeShortFamily(id)) {
      ignoredIds.push({
        id,
        reason: 'SHORT_OR_UNKNOWN_SIDE_DISABLED_IN_LONG_ONLY_SYSTEM'
      });
      continue;
    }

    const children = getChildrenForMacroId({
      micros,
      macroId: id,
      mode: mode === 'manual' ? defaultRotationMode() : mode
    }).filter(isManualEligible);

    if (children.length > 0) {
      expandedFromMacro[id] = uniqueStrings(
        children.map((child) => child.microFamilyId)
      );

      for (const child of children) {
        addRow(child);
      }

      continue;
    }

    const directRow = micros[id];
    const upperRow = microsByUpperId[String(id || '').toUpperCase()];
    const row = directRow || upperRow;

    if (
      row &&
      isLongRotationRow(row) &&
      isTrueMicroFamily(row) &&
      isManualEligible(row)
    ) {
      addRow(row);
      continue;
    }

    if (!row && isKnownTrueMicroId(id) && allowManualUnknownTrueMicroIds()) {
      const manualRow = buildManualOnlyRow(id, selectedRows.length + 1);

      if (manualRow) {
        addRow(manualRow);
        continue;
      }
    }

    ignoredIds.push({
      id,
      reason: row
        ? 'ROW_IS_NOT_LONG_TRUE_MICRO_OR_NOT_ELIGIBLE'
        : 'UNKNOWN_LONG_TRUE_MICRO_OR_MACRO_WITHOUT_CHILDREN'
    });
  }

  return {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  };
}

export async function activateSelectedMicroFamilies({
  microFamilyIds = [],
  weekKey = getIsoWeekKey(),
  mode = 'manual'
} = {}) {
  const redis = getDurableRedis();

  const {
    micros,
    usedPreviousWeekMerge,
    primaryRows,
    previousRows
  } = await getRotationMicros(weekKey);

  const requestedIds = uniqueStrings(microFamilyIds);

  const {
    selectedRows,
    ignoredIds,
    expandedFromMacro
  } = resolveManualSelection({
    requestedIds,
    micros,
    mode
  });

  const microFamilies = selectedRows
    .filter(isLongRotationRow)
    .filter(isTrueMicroFamily)
    .map((row, index) => {
      if (row.manualOnly) {
        return {
          ...row,
          rank: index + 1
        };
      }

      return compactRotationRow(row, index + 1);
    })
    .filter((row) => row.microFamilyId);

  const indexes = buildSelectionIndexes(microFamilies);

  const active = {
    rotationId: randomId(`ROT_${weekKey}_manual_long_only`),
    source: 'ADMIN_MANUAL_SELECTION_LONG_TRUE_MICRO_ONLY',
    mode,

    sourceWeekKey: weekKey,
    activeWeekKey: getIsoWeekKey(),

    generatedAt: now(),
    activatedAt: now(),
    strategyVersion: CONFIG.strategyVersion,

    schema: schemaMeta().schema,
    macroSchema: schemaMeta().macroSchema,
    microSchema: schemaMeta().microSchema,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,

    usedLegacyFallback: false,
    usedSoftFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'SOFT'),
    usedObservationFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'OBSERVATION'),
    usedRawFallback: microFamilies.some((row) => row.rotationEligibilityTier === 'NONE'),
    usedPreviousWeekMerge,

    minWeightedCompleted: minWeightedCompleted(),
    topNPerSide: topNPerSide(),
    maxPerMacroFamily: maxPerMacroFamily(),

    primaryRows,
    previousRows,

    empty: indexes.microFamilyIds.length === 0,
    emptyReason: indexes.microFamilyIds.length === 0
      ? 'NO_LONG_TRUE_MICRO_IDS_SELECTED'
      : null,

    requestedMicroFamilyIds: requestedIds,
    ignoredRequestedIds: ignoredIds,
    expandedFromMacro,

    bestLong: bestLongRow(microFamilies),
    bestShort: null,
    missingSides: missingSides(microFamilies),

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    microFamilies
  };

  await setJson(
    redis,
    KEYS.analyze.activeRotation,
    active
  );

  return active;
}

function sanitizeDashboardRotation(rotation) {
  if (!rotation) return null;

  const rows = Array.isArray(rotation.microFamilies)
    ? rotation.microFamilies
      .filter(isLongRotationRow)
      .filter(isTrueMicroFamily)
      .map((row, index) => compactRotationRow(row, index + 1))
    : [];

  const indexes = buildSelectionIndexes(rows);

  return {
    ...rotation,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true,
    usedLegacyFallback: false,

    bestLong: bestLongRow(rows),
    bestShort: null,

    microFamilies: rows,

    microFamilyIds: indexes.microFamilyIds,
    activeMicroFamilyIds: indexes.activeMicroFamilyIds,
    trueMicroFamilyIds: indexes.trueMicroFamilyIds,

    macroFamilyIds: indexes.macroFamilyIds,
    activeMacroFamilyIds: indexes.activeMacroFamilyIds,

    microToMacroFamilyId: indexes.microToMacroFamilyId,
    macroToMicroFamilyIds: indexes.macroToMicroFamilyIds,

    missingSides: missingSides(rows),

    empty: rows.length === 0,
    emptyReason: rows.length === 0
      ? 'NO_LONG_TRUE_MICRO_FAMILIES_IN_ROTATION'
      : rotation.emptyReason || null
  };
}

export async function getRotationDashboard() {
  const redis = getDurableRedis();

  const [activeRaw, nextRaw, validFrom] = await Promise.all([
    getJson(redis, KEYS.analyze.activeRotation, null),
    getJson(redis, KEYS.analyze.nextRotation, null),
    getJson(redis, KEYS.analyze.rotationValidFrom, null)
  ]);

  const active = sanitizeDashboardRotation(activeRaw);
  const next = sanitizeDashboardRotation(nextRaw);

  const activeRows = Array.isArray(active?.microFamilies)
    ? active.microFamilies
    : [];

  const nextRows = Array.isArray(next?.microFamilies)
    ? next.microFamilies
    : [];

  return {
    active,
    next,
    validFrom,

    activeRows,
    nextRows,

    activeCount: active?.microFamilyIds?.length || 0,
    nextCount: next?.microFamilyIds?.length || 0,

    activeMacroCount: active?.macroFamilyIds?.length || 0,
    nextMacroCount: next?.macroFamilyIds?.length || 0,

    activeMicroFamilyIds: active?.microFamilyIds || [],
    nextMicroFamilyIds: next?.microFamilyIds || [],

    activeMacroFamilyIds: active?.macroFamilyIds || active?.activeMacroFamilyIds || [],
    nextMacroFamilyIds: next?.macroFamilyIds || next?.activeMacroFamilyIds || [],

    activeMicroToMacroFamilyId: active?.microToMacroFamilyId || {},
    nextMicroToMacroFamilyId: next?.microToMacroFamilyId || {},

    activeMacroToMicroFamilyIds: active?.macroToMicroFamilyIds || {},
    nextMacroToMicroFamilyIds: next?.macroToMicroFamilyIds || {},

    bestLong: active?.bestLong || null,
    bestShort: null,
    nextBestLong: next?.bestLong || null,
    nextBestShort: null,

    missingSides: active?.missingSides || [TARGET_TRADE_SIDE],
    nextMissingSides: next?.missingSides || [TARGET_TRADE_SIDE],

    usedSoftFallback: Boolean(active?.usedSoftFallback),
    nextUsedSoftFallback: Boolean(next?.usedSoftFallback),

    usedObservationFallback: Boolean(active?.usedObservationFallback),
    nextUsedObservationFallback: Boolean(next?.usedObservationFallback),

    usedRawFallback: Boolean(active?.usedRawFallback),
    nextUsedRawFallback: Boolean(next?.usedRawFallback),

    usedPreviousWeekMerge: Boolean(active?.usedPreviousWeekMerge),
    nextUsedPreviousWeekMerge: Boolean(next?.usedPreviousWeekMerge),

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,
    trueMicroOnly: true
  };
}