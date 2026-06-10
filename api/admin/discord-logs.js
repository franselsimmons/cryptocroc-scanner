// ================= FILE: api/admin/discord-logs.js =================

import { KEYS } from '../../src/keys.js';
import { getDurableRedis, readJsonLogs } from '../../src/redis.js';
import { sideToTradeSide } from '../../src/utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const TRUE_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

function methodNotAllowed(res) {
  res.setHeader('Allow', 'GET');

  return res.status(405).json({
    ok: false,
    error: 'METHOD_NOT_ALLOWED',
    allowed: ['GET']
  });
}

function firstQueryValue(value, fallback = null) {
  if (Array.isArray(value)) return value[0] ?? fallback;
  if (value === undefined || value === null || value === '') return fallback;

  return value;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;

  const raw = String(value).trim().toLowerCase();

  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;

  return fallback;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanText(value = '') {
  return upper(value)
    .replaceAll('SHORT_DISABLED', '')
    .replaceAll('SHORTDISABLED', '')
    .replaceAll('BLOCK_SHORT', '')
    .replaceAll('SHORT_ENABLED_FALSE', '')
    .replaceAll('SHORT_ONLY_FALSE', '')
    .replaceAll('LONG_DISABLED_FALSE', '')
    .replaceAll('LONG_ENABLED_FALSE', '')
    .replaceAll('LONG_ONLY_FALSE', '')
    .replaceAll('LONG_ONLY_MODE', 'LONG')
    .replaceAll('LONG_ONLY', 'LONG')
    .replaceAll('LONG-ONLY', 'LONG');
}

function clampLimit(value, fallback = 100) {
  const limit = Number(value);

  if (!Number.isFinite(limit)) return fallback;
  if (limit < 1) return 1;
  if (limit > 500) return 500;

  return Math.floor(limit);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function normalizeSideToken(value) {
  const raw = cleanText(value);

  if (!raw) return 'UNKNOWN';

  const direct = sideToTradeSide(raw);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === OPPOSITE_TRADE_SIDE) return OPPOSITE_TRADE_SIDE;

  if (['LONG', 'BULL', 'BULLISH', 'BUY', 'UP', 'UPSIDE'].includes(raw)) {
    return TARGET_TRADE_SIDE;
  }

  if (['SHORT', 'BEAR', 'BEARISH', 'SELL', 'DOWN', 'DOWNSIDE'].includes(raw)) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function hasLongSignal(text = '') {
  const raw = ` ${cleanText(text)} `;

  return (
    raw.includes('TRADE_SIDE=LONG') ||
    raw.includes('TRADESIDE=LONG') ||
    raw.includes('SIDE=LONG') ||
    raw.includes('POSITION_SIDE=LONG') ||
    raw.includes('POSITIONSIDE=LONG') ||
    raw.includes('DIRECTION=LONG') ||
    raw.includes('SIDE=BULL') ||
    raw.includes('DIRECTION=BULL') ||
    raw.includes('SIDE=BUY') ||
    raw.includes('DIRECTION=BUY') ||
    raw.includes('MICRO_LONG_') ||
    raw.includes(' LONG_') ||
    raw.includes('_LONG ') ||
    raw.includes('_LONG_') ||
    raw.includes('|LONG|') ||
    raw.includes(':LONG') ||
    raw.includes('=LONG') ||
    raw.includes(' BULL ') ||
    raw.includes('_BULL') ||
    raw.includes('BULL_') ||
    raw.includes('|BULL|') ||
    raw.includes(':BULL') ||
    raw.includes('=BULL') ||
    raw.includes(' BUY ') ||
    raw.includes('_BUY') ||
    raw.includes('BUY_') ||
    raw.includes('|BUY|') ||
    raw.includes(':BUY') ||
    raw.includes('=BUY')
  );
}

function hasShortSignal(text = '') {
  const raw = ` ${cleanText(text)} `;

  return (
    raw.includes('TRADE_SIDE=SHORT') ||
    raw.includes('TRADESIDE=SHORT') ||
    raw.includes('SIDE=SHORT') ||
    raw.includes('POSITION_SIDE=SHORT') ||
    raw.includes('POSITIONSIDE=SHORT') ||
    raw.includes('DIRECTION=SHORT') ||
    raw.includes('SIDE=BEAR') ||
    raw.includes('DIRECTION=BEAR') ||
    raw.includes('SIDE=SELL') ||
    raw.includes('DIRECTION=SELL') ||
    raw.includes('MICRO_SHORT_') ||
    raw.includes(' SHORT_') ||
    raw.includes('_SHORT ') ||
    raw.includes('_SHORT_') ||
    raw.includes('|SHORT|') ||
    raw.includes(':SHORT') ||
    raw.includes('=SHORT') ||
    raw.includes(' BEAR ') ||
    raw.includes('_BEAR') ||
    raw.includes('BEAR_') ||
    raw.includes('|BEAR|') ||
    raw.includes(':BEAR') ||
    raw.includes('=BEAR') ||
    raw.includes(' SELL ') ||
    raw.includes('_SELL') ||
    raw.includes('SELL_') ||
    raw.includes('|SELL|') ||
    raw.includes(':SELL') ||
    raw.includes('=SELL')
  );
}

function sideHaystack(row = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  return [
    row.side,
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.signalSide,
    row.scannerSide,
    row.analysisSide,

    payload.side,
    payload.tradeSide,
    payload.positionSide,
    payload.direction,
    payload.signalSide,
    payload.scannerSide,
    payload.analysisSide,

    result.side,
    result.tradeSide,
    result.positionSide,
    result.direction,

    row.familyId,
    row.macroFamilyId,
    row.parentMacroFamilyId,
    row.microFamilyId,
    row.trueMicroFamilyId,

    payload.familyId,
    payload.macroFamilyId,
    payload.parentMacroFamilyId,
    payload.microFamilyId,
    payload.trueMicroFamilyId,

    result.familyId,
    result.macroFamilyId,
    result.parentMacroFamilyId,
    result.microFamilyId,
    result.trueMicroFamilyId,

    row.type,
    row.reason,
    row.message,

    payload.type,
    payload.reason,
    payload.message,

    result.type,
    result.reason,
    result.message,

    ...safeArray(row.definitionParts),
    ...safeArray(payload.definitionParts),
    ...safeArray(result.definitionParts),

    ...safeArray(row.executionFingerprintParts),
    ...safeArray(payload.executionFingerprintParts),
    ...safeArray(result.executionFingerprintParts)
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(' | ');
}

function inferTradeSide(row = {}) {
  if (row.inferredTradeSide === TARGET_TRADE_SIDE || row.rawInferredTradeSide === TARGET_TRADE_SIDE) {
    return TARGET_TRADE_SIDE;
  }

  if (row.inferredTradeSide === OPPOSITE_TRADE_SIDE || row.rawInferredTradeSide === OPPOSITE_TRADE_SIDE) {
    return OPPOSITE_TRADE_SIDE;
  }

  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  const directSources = [
    row.tradeSide,
    row.positionSide,
    row.direction,
    row.side,

    payload.tradeSide,
    payload.positionSide,
    payload.direction,
    payload.side,

    result.tradeSide,
    result.positionSide,
    result.direction,
    result.side
  ];

  for (const source of directSources) {
    const side = normalizeSideToken(source);

    if (side === TARGET_TRADE_SIDE || side === OPPOSITE_TRADE_SIDE) return side;
  }

  const text = sideHaystack(row);
  const longSignal = hasLongSignal(text);
  const shortSignal = hasShortSignal(text);

  if (longSignal && !shortSignal) return TARGET_TRADE_SIDE;
  if (shortSignal && !longSignal) return OPPOSITE_TRADE_SIDE;

  if (longSignal && shortSignal) {
    const microId = cleanText(
      row.trueMicroFamilyId ||
      row.microFamilyId ||
      payload.trueMicroFamilyId ||
      payload.microFamilyId ||
      result.trueMicroFamilyId ||
      result.microFamilyId
    );

    if (microId.includes('MICRO_LONG_')) return TARGET_TRADE_SIDE;
    if (microId.includes('MICRO_SHORT_')) return OPPOSITE_TRADE_SIDE;
  }

  if (row.longOnly === true || payload.longOnly === true || result.longOnly === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortDisabled === true || payload.shortDisabled === true || result.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  if (row.shortOnly === true || payload.shortOnly === true || result.shortOnly === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  if (row.longDisabled === true || payload.longDisabled === true || result.longDisabled === true) {
    return OPPOSITE_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isLongLog(row = {}) {
  if (row.rawInferredTradeSide === TARGET_TRADE_SIDE) return true;
  if (row.inferredTradeSide === TARGET_TRADE_SIDE) return true;

  return inferTradeSide(row) === TARGET_TRADE_SIDE;
}

function isShortLog(row = {}) {
  if (row.rawInferredTradeSide === OPPOSITE_TRADE_SIDE) return true;
  if (row.inferredTradeSide === OPPOSITE_TRADE_SIDE) return true;

  return inferTradeSide(row) === OPPOSITE_TRADE_SIDE;
}

function normalizeType(row = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  return upper(
    row.type ||
    payload.type ||
    result.type ||
    row.level ||
    payload.level ||
    result.level ||
    'UNKNOWN'
  );
}

function normalizeReason(row = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  return (
    row.reason ||
    payload.reason ||
    result.reason ||
    row.error ||
    payload.error ||
    result.error ||
    null
  );
}

function normalizeResult(row = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  if (Object.keys(result).length > 0) {
    return result;
  }

  return null;
}

function normalizeSource(row = {}) {
  const payload = safeObject(row.payload);
  const result = safeObject(row.result || payload.result);

  const raw = upper(
    row.source ||
    row.positionSource ||
    row.tradeSource ||
    payload.source ||
    payload.positionSource ||
    payload.tradeSource ||
    result.source ||
    result.positionSource ||
    result.tradeSource ||
    ''
  );

  if (!raw) return null;
  if (raw === 'VIRTUAL' || raw === 'SHADOW' || raw === 'PAPER') return 'VIRTUAL';

  return raw;
}

function normalizeLog(row = {}) {
  const payload = safeObject(row.payload);
  const result = normalizeResult(row);
  const resultObject = safeObject(result);

  const rawInferredTradeSide = inferTradeSide(row);
  const type = normalizeType(row);
  const reason = normalizeReason(row);
  const source = normalizeSource(row);

  const symbol =
    row.symbol ||
    row.contractSymbol ||
    payload.symbol ||
    payload.contractSymbol ||
    resultObject.symbol ||
    resultObject.contractSymbol ||
    null;

  const trueMicroFamilyId =
    row.trueMicroFamilyId ||
    payload.trueMicroFamilyId ||
    resultObject.trueMicroFamilyId ||
    row.microFamilyId ||
    payload.microFamilyId ||
    resultObject.microFamilyId ||
    null;

  const microFamilyId = trueMicroFamilyId;

  const familyId =
    row.familyId ||
    payload.familyId ||
    resultObject.familyId ||
    null;

  const macroFamilyId =
    row.macroFamilyId ||
    row.parentMacroFamilyId ||
    payload.macroFamilyId ||
    payload.parentMacroFamilyId ||
    resultObject.macroFamilyId ||
    resultObject.parentMacroFamilyId ||
    null;

  const discordAlertEligible = Boolean(firstDefined(
    row.discordAlertEligible,
    payload.discordAlertEligible,
    resultObject.discordAlertEligible,
    false
  ));

  const selectedMicroFamilyAlert = Boolean(firstDefined(
    row.selectedMicroFamilyAlert,
    payload.selectedMicroFamilyAlert,
    resultObject.selectedMicroFamilyAlert,
    false
  ));

  const virtualOnlyFlag = Boolean(firstDefined(
    row.virtualOnly,
    payload.virtualOnly,
    resultObject.virtualOnly,
    row.virtualTracked,
    payload.virtualTracked,
    resultObject.virtualTracked,
    row.shadowOnly,
    payload.shadowOnly,
    resultObject.shadowOnly,
    false
  ));

  const virtualOnly = Boolean(source === 'VIRTUAL' || virtualOnlyFlag);

  const skipped = Boolean(firstDefined(
    row.skipped,
    payload.skipped,
    resultObject.skipped,
    false
  ));

  const failed = Boolean(firstDefined(
    row.failed,
    payload.failed,
    resultObject.failed,
    resultObject.ok === false ? true : undefined,
    false
  ));

  const explicitSent = firstDefined(
    row.sent,
    payload.sent,
    resultObject.sent
  );

  const sent = explicitSent !== undefined
    ? Boolean(explicitSent)
    : Boolean(
      !skipped &&
      !failed &&
      (
        type.includes('SENT') ||
        resultObject.ok === true
      )
    );

  const entryAlert = (
    type.includes('ENTRY') ||
    String(reason || '').toUpperCase().includes('ENTRY')
  );

  const exitAlert = (
    type.includes('EXIT') ||
    String(reason || '').toUpperCase().includes('EXIT')
  );

  const alertAllowed = selectedMicroFamilyAlert === true;
  const blockedByManualSelection = discordAlertEligible === true && selectedMicroFamilyAlert !== true;
  const policyViolation = sent === true && selectedMicroFamilyAlert !== true;

  return {
    ...row,

    type,

    payload,
    result,

    reason,
    source,

    symbol,

    side: TARGET_DASHBOARD_SIDE,
    tradeSide: TARGET_TRADE_SIDE,
    positionSide: TARGET_TRADE_SIDE,
    direction: TARGET_TRADE_SIDE,

    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,
    virtualLearningForced: true,

    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsUsedAsLearningFamily: false,
    learningIdentitySource: 'ANALYZE_TRUE_MICRO_FAMILY',
    symbolExcludedFromFamilyId: true,

    rawInferredTradeSide,
    inferredTradeSide: rawInferredTradeSide,

    microFamilyId,
    trueMicroFamilyId,
    familyId,
    macroFamilyId,

    virtualOnly,
    virtualTracked: virtualOnly,
    shadowOnly: virtualOnly,

    discordAlertEligible,
    selectedMicroFamilyAlert,

    manualSelectionRequired: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',
    alertAllowed,
    blockedByManualSelection,
    policyViolation,

    entryAlert,
    exitAlert,

    sent,
    skipped,
    failed,

    ts:
      row.ts ||
      row.createdAt ||
      payload.ts ||
      payload.createdAt ||
      resultObject.ts ||
      resultObject.createdAt ||
      null
  };
}

function filterByType(logs = [], type = null) {
  if (!type) return logs;

  const wanted = String(type).toUpperCase();

  return logs.filter((log) => String(log.type || '').toUpperCase() === wanted);
}

function filterBySymbol(logs = [], symbol = null) {
  if (!symbol) return logs;

  const wanted = String(symbol).trim().toUpperCase();

  return logs.filter((log) => (
    String(log.symbol || '').trim().toUpperCase() === wanted ||
    String(log.contractSymbol || '').trim().toUpperCase() === wanted ||
    String(log.payload?.symbol || '').trim().toUpperCase() === wanted ||
    String(log.payload?.contractSymbol || '').trim().toUpperCase() === wanted ||
    String(log.result?.symbol || '').trim().toUpperCase() === wanted ||
    String(log.result?.contractSymbol || '').trim().toUpperCase() === wanted
  ));
}

function filterByMicroFamilyId(logs = [], microFamilyId = null) {
  if (!microFamilyId) return logs;

  const wanted = String(microFamilyId).trim();

  return logs.filter((log) => (
    String(log.trueMicroFamilyId || '').trim() === wanted ||
    String(log.payload?.trueMicroFamilyId || '').trim() === wanted ||
    String(log.result?.trueMicroFamilyId || '').trim() === wanted
  ));
}

function filterSelectedOnly(logs = [], selectedOnly = false) {
  if (!selectedOnly) return logs;

  return logs.filter((log) => (
    log.selectedMicroFamilyAlert === true ||
    log.alertAllowed === true
  ));
}

function buildSummary(logs = []) {
  return logs.reduce((acc, log) => {
    const type = String(log.type || 'UNKNOWN').toUpperCase();
    const reason = String(log.reason || 'NO_REASON').toUpperCase();

    acc.total += 1;

    acc.byType[type] = (acc.byType[type] || 0) + 1;
    acc.byReason[reason] = (acc.byReason[reason] || 0) + 1;

    if (log.sent) acc.sent += 1;
    if (log.failed) acc.failed += 1;
    if (log.skipped) acc.skipped += 1;

    if (log.entryAlert) acc.entryAlerts += 1;
    if (log.exitAlert) acc.exitAlerts += 1;

    if (log.virtualOnly || log.virtualTracked || log.shadowOnly || log.source === 'VIRTUAL') {
      acc.virtual += 1;
    }

    if (log.discordAlertEligible) {
      acc.eligible += 1;
    }

    if (log.selectedMicroFamilyAlert) {
      acc.selected += 1;
    }

    if (log.alertAllowed) {
      acc.alertAllowed += 1;
    }

    if (log.blockedByManualSelection) {
      acc.blockedByManualSelection += 1;
    }

    if (log.policyViolation) {
      acc.policyViolations += 1;
    }

    if (log.rawInferredTradeSide === OPPOSITE_TRADE_SIDE || log.inferredTradeSide === OPPOSITE_TRADE_SIDE) {
      acc.shortFilteredLeaks += 1;
    }

    return acc;
  }, {
    total: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    entryAlerts: 0,
    exitAlerts: 0,
    virtual: 0,
    eligible: 0,
    selected: 0,
    alertAllowed: 0,
    blockedByManualSelection: 0,
    policyViolations: 0,
    shortFilteredLeaks: 0,
    byType: {},
    byReason: {}
  });
}

function getLongDiscordLogKey() {
  return (
    KEYS.discord?.longLogList ||
    KEYS.discordLong?.logList ||
    KEYS.long?.discord?.logList ||
    `LONG:${KEYS.discord.logList}`
  );
}

function baseModePayload() {
  return {
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,

    longOnly: true,
    shortDisabled: true,
    shortOnly: false,
    longDisabled: false,

    realOrdersDisabled: true,
    bitgetOrdersDisabled: true,
    exchangeCallsDisabled: true,

    virtualLearningForced: true,
    virtualPositionsOnly: true,
    shadowPositionsVisible: true,

    maxOneOpenPositionPerSymbol: true,
    globalMaxOpenPositionsBlockDisabled: true,

    manualSelectionRequired: true,
    discordOnlyForSelectedMicroFamilies: true,
    manualSelectionMatchMode: 'EXACT_TRUE_MICRO_FAMILY_ID',

    scannerSide: TARGET_DASHBOARD_SIDE,
    scannerFingerprintRole: 'METADATA_ONLY',
    scannerFingerprintsUsedAsLearningFamily: false,

    redisNamespace: 'LONG',
    discordLogKeyNamespace: 'LONG',
    redisKeysSeparatedFromShortRoot: true
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Admin-Discord-Logs-Mode', 'long-only-selected-virtual-v3');
  res.setHeader('X-Target-Trade-Side', TARGET_TRADE_SIDE);
  res.setHeader('X-Long-Only', 'true');
  res.setHeader('X-Short-Disabled', 'true');
  res.setHeader('X-Manual-Selection-Required', 'true');
  res.setHeader('X-Manual-Selection-Match-Mode', 'EXACT_TRUE_MICRO_FAMILY_ID');
  res.setHeader('X-Real-Orders-Disabled', 'true');
  res.setHeader('X-Bitget-Orders-Disabled', 'true');
  res.setHeader('X-Virtual-Learning-Forced', 'true');
  res.setHeader('X-Redis-Namespace', 'LONG');

  try {
    if (req.method !== 'GET') {
      return methodNotAllowed(res);
    }

    const limit = clampLimit(firstQueryValue(req.query?.limit, 100), 100);
    const type = firstQueryValue(req.query?.type, null);
    const symbol = firstQueryValue(req.query?.symbol, null);
    const microFamilyId = firstQueryValue(req.query?.microFamilyId, null);
    const selectedOnly = bool(firstQueryValue(req.query?.selectedOnly, false), false);
    const includeShortRequested = bool(firstQueryValue(req.query?.includeShort, false), false);

    const hasPostFilters = Boolean(type || symbol || microFamilyId || selectedOnly);
    const fetchLimit = hasPostFilters
      ? Math.min(500, Math.max(limit, limit * 5))
      : limit;

    const redis = getDurableRedis();
    const discordLogKey = getLongDiscordLogKey();

    const rawLogs = await readJsonLogs(
      redis,
      discordLogKey,
      fetchLimit
    );

    const normalized = (Array.isArray(rawLogs) ? rawLogs : [])
      .map(normalizeLog);

    const longOnlyLogs = normalized.filter(isLongLog);
    const shortBlockedCount = normalized.filter(isShortLog).length;
    const unknownBlockedCount = normalized.length - longOnlyLogs.length - shortBlockedCount;

    const filteredLogs = filterSelectedOnly(
      filterByMicroFamilyId(
        filterBySymbol(
          filterByType(longOnlyLogs, type),
          symbol
        ),
        microFamilyId
      ),
      selectedOnly
    );

    const logs = filteredLogs.slice(0, limit);

    return res.status(200).json({
      ok: true,

      ...baseModePayload(),

      limit,
      fetchLimit,
      type,
      symbol,
      microFamilyId,
      selectedOnly,

      includeShortRequested,
      includeShortIgnored: includeShortRequested,
      shortHardBlocked: true,

      discordLogKey,

      count: logs.length,
      totalMatched: filteredLogs.length,
      totalFetched: Array.isArray(rawLogs) ? rawLogs.length : 0,
      totalAfterLongFilter: longOnlyLogs.length,
      shortBlockedCount,
      unknownBlockedCount,

      summary: buildSummary(logs),

      logs,

      serverTs: Date.now()
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      ...baseModePayload(),

      error: error?.message || String(error),
      stack: process.env.NODE_ENV === 'production'
        ? undefined
        : error?.stack
    });
  }
}