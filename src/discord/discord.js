// ================= FILE: src/discord/discord.js =================

import { CONFIG } from '../config.js';
import { KEYS } from '../keys.js';
import { getDurableRedis, pushJsonLog } from '../redis.js';
import {
  normalizeBaseSymbol,
  safeNumber,
  sideToTradeSide
} from '../utils.js';

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const BLOCKED_TRADE_SIDE = 'SHORT';

const DISCORD_LIMITS = {
  fieldName: 256,
  fieldValue: 1024
};

const LONG_TOKENS = new Set([
  'LONG',
  'BULL',
  'BULLISH',
  'BUY'
]);

const SHORT_TOKENS = new Set([
  'SHORT',
  'BEAR',
  'BEARISH',
  'SELL'
]);

function nowIso() {
  return new Date().toISOString();
}

function discordConfig() {
  return {
    enabled: CONFIG.discord?.enabled !== false,
    webhookUrl: CONFIG.discord?.webhookUrl || '',
    timeoutMs: Math.max(500, safeNumber(CONFIG.discord?.timeoutMs, 2500)),
    logLimit: Math.max(1, Math.floor(safeNumber(CONFIG.discord?.logLimit, 250)))
  };
}

function truncate(value, max = 1024) {
  const text = String(value ?? '');

  if (text.length <= max) return text;

  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function field(name, value, inline = true) {
  return {
    name: truncate(name || 'Field', DISCORD_LIMITS.fieldName),
    value: truncate(value ?? 'NA', DISCORD_LIMITS.fieldValue) || 'NA',
    inline
  };
}

function fmtPrice(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  if (n >= 1000) return n.toFixed(2);
  if (n >= 1) return n.toFixed(6);

  return n.toFixed(10);
}

function fmtPct(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${(n * 100).toFixed(2)}%`;
}

function fmtR(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) return 'NA';

  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}R`;
}

function upper(value, fallback = '') {
  const text = String(value ?? '').trim();

  return text ? text.toUpperCase() : fallback;
}

function normalizeSideToken(value) {
  const direct = sideToTradeSide(value);

  if (direct === TARGET_TRADE_SIDE) return TARGET_TRADE_SIDE;
  if (direct === BLOCKED_TRADE_SIDE) return BLOCKED_TRADE_SIDE;

  const raw = upper(value);

  if (!raw) return 'UNKNOWN';
  if (LONG_TOKENS.has(raw)) return TARGET_TRADE_SIDE;
  if (SHORT_TOKENS.has(raw)) return BLOCKED_TRADE_SIDE;

  return 'UNKNOWN';
}

function definitionParts(payload = {}) {
  return [
    payload.definition,
    payload.microDefinition,
    payload.macroDefinition,
    payload.parentDefinition,

    ...(Array.isArray(payload.definitionParts) ? payload.definitionParts : []),
    ...(Array.isArray(payload.microDefinitionParts) ? payload.microDefinitionParts : []),
    ...(Array.isArray(payload.macroDefinitionParts) ? payload.macroDefinitionParts : []),
    ...(Array.isArray(payload.parentDefinitionParts) ? payload.parentDefinitionParts : [])
  ]
    .map((value) => upper(value))
    .filter(Boolean);
}

function idHaystack(payload = {}) {
  return [
    payload.familyId,
    payload.family,
    payload.baseFamilyId,

    payload.microFamilyId,
    payload.trueMicroFamilyId,
    payload.id,
    payload.key,

    payload.macroFamilyId,
    payload.parentMacroFamilyId,
    payload.parentMicroFamilyId,
    payload.parentFamilyId,
    payload.macroId,
    payload.activeMacroFamilyId
  ]
    .map((value) => upper(value))
    .filter(Boolean)
    .join('|');
}

function hasLongIdSignal(value = '') {
  const raw = upper(value);

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

function hasShortIdSignal(value = '') {
  const raw = upper(value);

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

function inferTradeSide(payload = {}) {
  if (typeof payload !== 'object' || payload === null) {
    return normalizeSideToken(payload);
  }

  const directSources = [
    payload.tradeSide,
    payload.positionSide,
    payload.direction,
    payload.signalSide,
    payload.scannerSide,
    payload.actualScannerSide,
    payload.analysisSide,
    payload.side
  ];

  for (const value of directSources) {
    const side = normalizeSideToken(value);

    if (side === TARGET_TRADE_SIDE || side === BLOCKED_TRADE_SIDE) {
      return side;
    }
  }

  const ids = idHaystack(payload);

  if (hasShortIdSignal(ids)) return BLOCKED_TRADE_SIDE;
  if (hasLongIdSignal(ids)) return TARGET_TRADE_SIDE;

  const parts = definitionParts(payload);

  if (hasShortDefinitionSignal(parts)) return BLOCKED_TRADE_SIDE;
  if (hasLongDefinitionSignal(parts)) return TARGET_TRADE_SIDE;

  if (payload.longOnly === true && payload.shortDisabled === true) {
    return TARGET_TRADE_SIDE;
  }

  return 'UNKNOWN';
}

function isTargetPayload(payload = {}) {
  return inferTradeSide(payload) === TARGET_TRADE_SIDE;
}

function normalizeSideLabel(payload = {}) {
  return isTargetPayload(payload) ? TARGET_TRADE_SIDE : 'NON_LONG_SKIPPED';
}

function discordColorForSide(payload = {}) {
  return isTargetPayload(payload) ? 0x22c55e : 0x64748b;
}

function discordColorForResult(value) {
  const r = safeNumber(value, 0);

  if (r > 0) return 0x2563eb;
  if (r < 0) return 0xdc2626;

  return 0x94a3b8;
}

function extractExitPrice(outcome = {}) {
  return (
    outcome.exit ??
    outcome.exitPrice ??
    outcome.close ??
    outcome.closePrice ??
    outcome.price ??
    outcome.lastPrice ??
    null
  );
}

function extractResultR(outcome = {}) {
  return (
    outcome.netR ??
    outcome.exitR ??
    outcome.grossR ??
    null
  );
}

function compactPayload(payload = {}) {
  const tradeSide = inferTradeSide(payload);

  return {
    symbol: payload.symbol || null,
    contractSymbol: payload.contractSymbol || null,

    side: tradeSide === TARGET_TRADE_SIDE
      ? TARGET_DASHBOARD_SIDE
      : payload.side || null,

    tradeSide,

    action: payload.action || null,
    reason: payload.reason || null,
    exitReason: payload.exitReason || null,

    microFamilyId: payload.microFamilyId || payload.trueMicroFamilyId || null,
    familyId: payload.familyId || null,

    macroFamilyId:
      payload.activeMacroFamilyId ||
      payload.parentMacroFamilyId ||
      payload.parentMicroFamilyId ||
      payload.macroFamilyId ||
      null,

    activeRotationId: payload.activeRotationId || null,

    entry: payload.entry ?? null,
    exit: extractExitPrice(payload),
    sl: payload.sl ?? null,
    tp: payload.tp ?? null,
    rr: payload.rr ?? null,

    exitR: payload.exitR ?? null,
    netR: payload.netR ?? null,
    grossR: payload.grossR ?? null,
    costR: payload.costR ?? null,
    pnlPct: payload.pnlPct ?? payload.netPnlPct ?? null,

    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true,

    ts: Date.now()
  };
}

async function postDiscord(content) {
  const cfg = discordConfig();

  if (!cfg.enabled || !cfg.webhookUrl) {
    return {
      ok: true,
      skipped: true,
      reason: 'DISCORD_DISABLED'
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const response = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(content),
      signal: controller.signal
    });

    const responseText = await response.text().catch(() => '');

    return {
      ok: response.ok,
      status: response.status,
      response: response.ok ? undefined : truncate(responseText, 500)
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === 'AbortError'
        ? 'DISCORD_TIMEOUT'
        : error?.message || String(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function logDiscord(type, payload, result) {
  try {
    const cfg = discordConfig();
    const redis = getDurableRedis();

    await pushJsonLog(
      redis,
      KEYS.discord.logList,
      {
        type,
        payload: compactPayload(payload),
        result,
        ts: Date.now()
      },
      cfg.logLimit
    );
  } catch {
    // Discord logging mag trade execution nooit blokkeren.
  }
}

async function skipNonTargetDiscord(type, payload = {}) {
  const result = {
    ok: true,
    skipped: true,
    reason: 'DISCORD_LONG_ONLY_SKIPPED_NON_LONG',
    detectedTradeSide: inferTradeSide(payload),
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  };

  await logDiscord(type, payload, result);

  return result;
}

export async function sendEntryAlert(entry = {}) {
  if (!isTargetPayload(entry)) {
    return skipNonTargetDiscord('ENTRY_SKIPPED', entry);
  }

  const symbol = normalizeBaseSymbol(entry.symbol || entry.contractSymbol);
  const side = normalizeSideLabel(entry);

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} ENTRY`,
        color: discordColorForSide(entry),
        fields: [
          field('Entry', fmtPrice(entry.entry), true),
          field('TP', fmtPrice(entry.tp), true),
          field('SL', fmtPrice(entry.sl), true),
          field('RR', fmtR(entry.rr), true),
          field('Micro', entry.microFamilyId || 'NA', false),
          field(
            'Macro',
            entry.activeMacroFamilyId ||
              entry.parentMacroFamilyId ||
              entry.parentMicroFamilyId ||
              entry.macroFamilyId ||
              'NA',
            false
          )
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('ENTRY', entry, result);

  return result;
}

export async function sendExitAlert(outcome = {}) {
  if (!isTargetPayload(outcome)) {
    return skipNonTargetDiscord('EXIT_SKIPPED', outcome);
  }

  const symbol = normalizeBaseSymbol(outcome.symbol || outcome.contractSymbol);
  const side = normalizeSideLabel(outcome);
  const exitPrice = extractExitPrice(outcome);
  const resultR = extractResultR(outcome);

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${symbol || 'UNKNOWN'} ${side} EXIT`,
        color: discordColorForResult(resultR),
        fields: [
          field('Exit', fmtPrice(exitPrice), true),
          field('Result', fmtR(resultR), true),
          field('Reason', outcome.exitReason || 'EXIT', true),
          field('Cost', fmtR(outcome.costR), true),
          field('PnL', fmtPct(outcome.pnlPct ?? outcome.netPnlPct), true),
          field('Micro', outcome.microFamilyId || 'NA', false)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('EXIT', outcome, result);

  return result;
}

function bestLongId(rotation = {}) {
  return (
    rotation.bestLong?.microFamilyId ||
    rotation.bestShort?.microFamilyId ||
    rotation.selectedMicroFamilyId ||
    rotation.microFamilyIds?.[0] ||
    rotation.activeMicroFamilyIds?.[0] ||
    rotation.trueMicroFamilyIds?.[0] ||
    'NA'
  );
}

export async function sendWeeklyRotationReport(rotationInput = {}, label = 'WEEKLY_ROTATION') {
  const rotation =
    rotationInput.rotation ||
    rotationInput.activeRotation ||
    rotationInput.nextRotation ||
    rotationInput;

  const microCount =
    rotation.microFamilyIds?.length ||
    rotation.activeMicroFamilyIds?.length ||
    rotation.trueMicroFamilyIds?.length ||
    rotation.microFamilies?.length ||
    0;

  const macroCount =
    rotation.macroFamilyIds?.length ||
    rotation.activeMacroFamilyIds?.length ||
    0;

  const week =
    rotation.sourceWeekKey ||
    rotation.activeWeekKey ||
    rotation.weekKey ||
    'NA';

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `${label} LONG ONLY`,
        color: rotation.empty ? 0xf59e0b : 0x7c3aed,
        fields: [
          field('Micro count', String(microCount), true),
          field('Macro count', String(macroCount), true),
          field('Mode', rotation.mode || 'NA', true),
          field('Week', week, true),
          field('Best LONG', bestLongId(rotation), false),
          field('Short disabled', 'true', true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('WEEKLY_ROTATION', {
    ...rotation,
    bestShort: null,
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  }, result);

  return result;
}

export async function sendResetReport(report = {}) {
  const deletedCount = Object.keys(report.deleted || {}).length;

  const content = {
    username: 'Micro-Family Trader',
    embeds: [
      {
        title: `RESET ${report.type || 'UNKNOWN'}`,
        color: report.ok ? 0xf59e0b : 0xdc2626,
        fields: [
          field('OK', String(Boolean(report.ok)), true),
          field('Reason', report.reason || 'OK', true),
          field('Deleted', String(deletedCount), true),
          field('Long only', 'true', true),
          field('Short disabled', 'true', true)
        ],
        timestamp: nowIso()
      }
    ]
  };

  const result = await postDiscord(content);
  await logDiscord('RESET', {
    ...report,
    targetTradeSide: TARGET_TRADE_SIDE,
    longOnly: true,
    shortDisabled: true
  }, result);

  return result;
}