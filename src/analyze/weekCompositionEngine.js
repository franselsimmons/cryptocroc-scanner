// ================= FILE: src/analyze/weekCompositionEngine.js =================

import { createHash } from 'node:crypto';
import { safeNumber } from '../utils.js';
import {
  TEMPORAL_DAY_BUCKETS,
  TEMPORAL_HOUR_BUCKETS,
  TEMPORAL_MARKET_WEATHER_KEYS,
  BTC_ROUTER_STATES,
  BTC_ROUTER_SELECTABLE_STATES,
  BTC_DIRECTION_ROUTER_PROFILE_VERSION,
  BTC_DIRECTION_ROUTER_POLICY_VERSION,
  temporalHourKey,
  temporalMarketWeatherKey,
  temporalBtcRouterKey,
  resolveEntryBtcRouterContext,
  temporalPolicyMode
} from './scoring.js';

export const WEEK_COMPOSITION_VERSION =
  'LONG_WEEK_COMPOSITION_DAY_HOUR_WEATHER_BTC_V5_CONTEXT_DISCOVERY_PREVIEW';
export const WEEK_COMPOSITION_OPTIMIZER_VERSION =
  'LONG_TOP3_DAY_HOUR_WEATHER_BTC_OPTIMIZER_V5_CONTEXT_DISCOVERY_PREVIEW';
export const HISTORICAL_CORRELATION_DIVERSIFICATION_VERSION =
  'LONG_HISTORICAL_CORRELATION_DIVERSIFICATION_V1';
export const WEEK_COMPOSITION_MODES = Object.freeze([
  'CONSERVATIVE',
  'BALANCED',
  'PERFORMANCE'
]);

const MODE_CONFIG = Object.freeze({
  CONSERVATIVE: Object.freeze({
    rank: 1,
    title: 'Veiligste BTC-gestuurde samenstelling',
    description:
      'Alleen de sterkst bewezen family-combinaties per weekdag, UTC-uur, marketWeather en BTC-richting.',
    maxFamiliesPerSlot: 2,
    minWeatherCompleted: 12,
    minWeatherAvgR: 0.05,
    minWeatherLcb95: 0,
    minWeatherWinrate: 0.54,
    minWeatherProfitFactor: 1.18,
    maxWeatherDirectSLPct: 0.30,
    minBtcCompleted: 10,
    minBtcAvgR: 0.05,
    minBtcLcb95: 0,
    minBtcWinrate: 0.54,
    minBtcProfitFactor: 1.15,
    minBlendedAvgR: 0.06,
    minDistinctDates: 6,
    minDistinctWeeks: 4,
    minDistinctSymbols: 3,
    minDistinctClusters: 6,
    requireDiversityPassed: true,
    counterMinCompleted: 14,
    counterMinAvgR: 0.10,
    counterMinLcb95: 0.02,
    counterMinWinrate: 0.57,
    counterMinProfitFactor: 1.25,
    minimumPositiveScore: 8
  }),
  BALANCED: Object.freeze({
    rank: 2,
    title: 'Gebalanceerde BTC-gestuurde samenstelling',
    description:
      'Sterke zekerheid en voldoende signalen, met BTC-richting als harde router en bewezen uitzonderingen.',
    maxFamiliesPerSlot: 3,
    minWeatherCompleted: 8,
    minWeatherAvgR: 0.02,
    minWeatherLcb95: -0.03,
    minWeatherWinrate: 0.51,
    minWeatherProfitFactor: 1.06,
    maxWeatherDirectSLPct: 0.38,
    minBtcCompleted: 7,
    minBtcAvgR: 0.03,
    minBtcLcb95: -0.02,
    minBtcWinrate: 0.51,
    minBtcProfitFactor: 1.06,
    minBlendedAvgR: 0.04,
    minDistinctDates: 5,
    minDistinctWeeks: 3,
    minDistinctSymbols: 3,
    minDistinctClusters: 5,
    requireDiversityPassed: false,
    counterMinCompleted: 11,
    counterMinAvgR: 0.08,
    counterMinLcb95: 0,
    counterMinWinrate: 0.54,
    counterMinProfitFactor: 1.16,
    minimumPositiveScore: 4
  }),
  PERFORMANCE: Object.freeze({
    rank: 3,
    title: 'Hoogste BTC-gestuurde potentie',
    description:
      'Hoogste verwachte netto-R en PnL, met tegen-BTC entries alleen als de exacte combinatie dat bewijst.',
    maxFamiliesPerSlot: 4,
    minWeatherCompleted: 6,
    minWeatherAvgR: 0.03,
    minWeatherLcb95: -0.05,
    minWeatherWinrate: 0.50,
    minWeatherProfitFactor: 1.00,
    maxWeatherDirectSLPct: 0.45,
    minBtcCompleted: 5,
    minBtcAvgR: 0.03,
    minBtcLcb95: -0.04,
    minBtcWinrate: 0.50,
    minBtcProfitFactor: 1.00,
    minBlendedAvgR: 0.05,
    minDistinctDates: 4,
    minDistinctWeeks: 3,
    minDistinctSymbols: 2,
    minDistinctClusters: 4,
    requireDiversityPassed: false,
    counterMinCompleted: 8,
    counterMinAvgR: 0.07,
    counterMinLcb95: -0.01,
    counterMinWinrate: 0.52,
    counterMinProfitFactor: 1.10,
    minimumPositiveScore: 3
  })
});

const DAY_SET = new Set(TEMPORAL_DAY_BUCKETS);
const HOUR_SET = new Set(TEMPORAL_HOUR_BUCKETS);
const WEATHER_SET = new Set(TEMPORAL_MARKET_WEATHER_KEYS);
const BTC_SET = new Set(BTC_ROUTER_STATES);
const BTC_SELECTABLE_SET = new Set(BTC_ROUTER_SELECTABLE_STATES);

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, finite(value, min)));
}

function upper(value = '') {
  return String(value || '').trim().toUpperCase();
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .filter((key) => key !== 'checksum')
      .map((key) => [key, canonicalize(value[key])])
  );
}

function checksum(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function exactFamilyId(value = '') {
  const id = upper(value);
  return /^MICRO_LONG_(BREAKOUT|RETEST|SWEEP_REVERSAL|CONTINUATION|COMPRESSION)_(TREND|CHOP|SQUEEZE)_(A_STRONG_ALIGN|B_FLOW_ALIGN|C_VOLUME_ALIGN|D_MIXED_OK|E_WEAK_CONTRA)$/.test(id)
    ? id
    : null;
}

function familyIdOf(row = {}) {
  return exactFamilyId(
    row.trueMicroFamilyId ||
    row.childTrueMicroFamilyId ||
    row.microFamilyId ||
    row.familyId
  );
}

function familyRowMap(micros = {}) {
  const rows = Array.isArray(micros) ? micros : Object.values(micros || {});
  return new Map(
    rows
      .map((row) => [familyIdOf(row), row])
      .filter(([id]) => Boolean(id))
  );
}

function projectionMapOf(generation = {}) {
  return new Map(
    (Array.isArray(generation.familyProjections)
      ? generation.familyProjections
      : [])
      .map((projection) => [exactFamilyId(projection.familyId), projection])
      .filter(([id]) => Boolean(id))
  );
}

function sessionBucketForHour(hourUtc) {
  const hour = Math.max(0, Math.min(23, Math.floor(finite(hourUtc, 0))));
  const asia = hour >= 0 && hour < 8;
  const europe = hour >= 7 && hour < 16;
  const us = hour >= 13 && hour < 22;
  if (europe && us) return 'EU_US_OVERLAP';
  if (asia && europe) return 'ASIA_EU_OVERLAP';
  if (asia) return 'ASIA';
  if (europe) return 'EUROPE';
  if (us) return 'US';
  return 'OFF_HOURS';
}

function slotKey(day, hourUtc, marketWeatherKey, btcState) {
  return `${upper(day)}:${temporalHourKey(hourUtc)}|${temporalMarketWeatherKey(marketWeatherKey)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

function parseSlotKey(value = '') {
  const raw = upper(value);
  const btcMarker = raw.lastIndexOf('|BTC:');
  const withoutBtc = btcMarker >= 0 ? raw.slice(0, btcMarker) : raw;
  const btcRaw = btcMarker >= 0 ? raw.slice(btcMarker + 5) : 'UNKNOWN';
  const firstPipe = withoutBtc.indexOf('|');
  const dayHourPart = firstPipe >= 0 ? withoutBtc.slice(0, firstPipe) : withoutBtc;
  const weatherRaw = firstPipe >= 0 ? withoutBtc.slice(firstPipe + 1) : 'UNKNOWN';
  const [day, hourBucket] = dayHourPart.split(':');
  return {
    day,
    hourBucket,
    hourUtc: HOUR_SET.has(hourBucket) ? Number(hourBucket.slice(1)) : null,
    marketWeatherKey: temporalMarketWeatherKey(weatherRaw),
    btcRouterState: temporalBtcRouterKey(btcRaw)
  };
}

const STRICT_GLOBAL_GATE_MIN_COMPLETED = 35;
const OBSERVE_PREVIEW_MIN_COMPLETED = 20;
const OBSERVE_PREVIEW_MIN_AVG_R = 0.01;
const OBSERVE_PREVIEW_MIN_BLENDED_AVG_R = 0.01;
const OBSERVE_PREVIEW_MIN_EXACT_COMPLETED = 1;

function compositionPolicyMode() {
  const mode = upper(temporalPolicyMode());
  return ['OFF', 'OBSERVE', 'ENFORCE'].includes(mode) ? mode : 'OBSERVE';
}

function globalGateEvaluation(row = {}) {
  const status = upper(
    row.activationGateStatus || row.familyGate || row.learningStatus || row.status
  );
  const completed = Math.max(0, Math.floor(finite(
    row.completedCurrentMeasurement ?? row.completed ?? row.outcomeSample,
    0
  )));
  const avgR = finite(row.avgR ?? row.avgNetR, 0);
  const empiricalVeto =
    row.empiricalVeto === true ||
    row.empiricalVetoed === true ||
    status === 'EMPIRICAL_VETO';
  const historicalContextDiscovery =
    row.historicalContextDiscoveryEligible === true &&
    row.strictDiscordEligibleFromHistorical !== true;
  const strictPassed =
    status === 'PASSED' ||
    (completed >= STRICT_GLOBAL_GATE_MIN_COMPLETED && avgR > 0 && !empiricalVeto);
  const observePreviewPassed =
    !strictPassed &&
    compositionPolicyMode() === 'OBSERVE' &&
    completed >= OBSERVE_PREVIEW_MIN_COMPLETED &&
    (avgR >= OBSERVE_PREVIEW_MIN_AVG_R || historicalContextDiscovery) &&
    !empiricalVeto;
  return {
    status,
    completed,
    avgR,
    empiricalVeto,
    historicalContextDiscovery,
    strictPassed,
    observePreviewPassed,
    acceptedForComposition: strictPassed || observePreviewPassed
  };
}

function globalGatePassed(row = {}) {
  return globalGateEvaluation(row).acceptedForComposition;
}

function metric(profile = {}) {
  const source = profile?.gateWindow || profile?.stats || profile || {};
  const completed = Math.max(0, Math.floor(finite(source.completed, 0)));
  const wins = Math.max(0, finite(source.wins, 0));
  const losses = Math.max(0, finite(source.losses, 0));
  const flats = Math.max(0, finite(source.flats, 0));
  const totalR = finite(source.sumNetR ?? source.totalR, 0);
  const totalNetPnlPct = finite(
    source.sumNetPnlPct ?? source.totalNetPnlPct ?? source.totalPnlPct,
    0
  );
  return {
    completed,
    wins,
    losses,
    flats,
    avgNetR: finite(source.avgNetR ?? source.avgR, completed > 0 ? totalR / completed : 0),
    totalR,
    avgNetPnlPct: finite(
      source.avgNetPnlPct ?? source.avgPnlPct,
      completed > 0 ? totalNetPnlPct / completed : 0
    ),
    totalNetPnlPct,
    lcb95: finite(source.lcb95, 0),
    ucb95: finite(source.ucb95, 0),
    winrate: clamp(source.winrate, 0, 1),
    profitFactor: Math.max(0, finite(source.profitFactor, 0)),
    directSLPct: clamp(source.directSLPct, 0, 1),
    avgCostR: Math.max(0, finite(source.avgCostR, 0)),
    grossWinR: Math.max(0, finite(source.grossWinR, 0)),
    grossLossR: Math.max(0, finite(source.grossLossR, 0)),
    lastOutcomeTs: Number.isFinite(Number(source.lastOutcomeTs))
      ? Number(source.lastOutcomeTs)
      : null
  };
}

function weightedMetric(parts = []) {
  let totalWeight = 0;
  const result = {
    avgNetR: 0,
    avgNetPnlPct: 0,
    winrate: 0,
    directSLPct: 0,
    avgCostR: 0
  };
  for (const part of parts) {
    const weight = Math.max(0, finite(part.weight, 0));
    if (weight <= 0) continue;
    const data = metric(part.metric);
    totalWeight += weight;
    result.avgNetR += data.avgNetR * weight;
    result.avgNetPnlPct += data.avgNetPnlPct * weight;
    result.winrate += data.winrate * weight;
    result.directSLPct += data.directSLPct * weight;
    result.avgCostR += data.avgCostR * weight;
  }
  if (totalWeight <= 0) return result;
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, value / totalWeight])
  );
}

function projectionDecision(profile = {}) {
  return upper(profile?.activeDecision || profile?.decision || 'NO_VETO');
}

function weekendApproved(projection = {}, day) {
  if (!['SATURDAY', 'SUNDAY'].includes(day)) return true;
  return upper(projection.weekendApprovals?.[day]?.approvalStatus) === 'WEEKEND_APPROVED';
}

function familyTaxonomy(projection = {}, row = {}) {
  return {
    setupType: upper(projection.setupType || row.setupType),
    regimeBucket: upper(projection.regimeBucket || row.regimeBucket),
    confirmationProfile: upper(
      projection.confirmationProfile || row.confirmationProfile
    )
  };
}

function diversityOf(profile = {}) {
  return profile?.diversity && typeof profile.diversity === 'object'
    ? profile.diversity
    : {};
}

function diversityCount(diversity = {}, ...keys) {
  for (const key of keys) {
    const value = Number(diversity?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function profileAt(projection, path = []) {
  let value = projection;
  for (const key of path) {
    if (!value || typeof value !== 'object') return {};
    value = value[key];
  }
  return value && typeof value === 'object' ? value : {};
}

function globalMetric(row = {}) {
  return metric({
    completed: row.completedCurrentMeasurement ?? row.completed,
    wins: row.wins,
    losses: row.losses,
    flats: row.flats,
    avgNetR: row.avgR ?? row.avgNetR,
    sumNetR: row.totalR,
    avgNetPnlPct: row.avgPnlPct ?? row.avgNetPnlPct,
    sumNetPnlPct: row.totalPnlPct ?? row.totalNetPnlPct,
    winrate: row.fairWinrate ?? row.winrate,
    profitFactor: row.profitFactor,
    directSLPct: row.directSLPct,
    avgCostR: row.avgCostR,
    lcb95: row.avgRLowerBound ?? row.lcb95 ?? row.wilsonLowerBound
  });
}

function strictBaseWeatherReasons({
  row,
  projection,
  day,
  weatherKey,
  weatherExact,
  weatherBlended,
  diversity,
  config,
  dayProfile,
  sessionProfile
}) {
  const reasons = [];
  if (!globalGateEvaluation(row).strictPassed) reasons.push('GLOBAL_GATE_NOT_PASSED');
  if (projectionDecision(dayProfile) === 'VETO_ACTIVE') reasons.push('DAY_VETO_ACTIVE');
  if (projectionDecision(sessionProfile) === 'VETO_ACTIVE') reasons.push('SESSION_VETO_ACTIVE');
  if (!weekendApproved(projection, day)) reasons.push('WEEKEND_NOT_APPROVED');
  if (weatherKey === 'UNKNOWN') reasons.push('UNKNOWN_MARKET_WEATHER_NOT_SELECTABLE');
  if (weatherExact.completed < config.minWeatherCompleted) reasons.push('EXACT_DAY_HOUR_WEATHER_SAMPLE_TOO_SMALL');
  if (weatherExact.avgNetR < config.minWeatherAvgR) reasons.push('EXACT_DAY_HOUR_WEATHER_AVG_R_TOO_LOW');
  if (weatherBlended.avgNetR < config.minBlendedAvgR) reasons.push('BLENDED_AVG_R_TOO_LOW');
  if (weatherExact.lcb95 <= config.minWeatherLcb95) reasons.push('EXACT_DAY_HOUR_WEATHER_LCB95_TOO_LOW');
  if (weatherExact.winrate < config.minWeatherWinrate) reasons.push('EXACT_DAY_HOUR_WEATHER_WINRATE_TOO_LOW');
  if (weatherExact.profitFactor < config.minWeatherProfitFactor) reasons.push('EXACT_DAY_HOUR_WEATHER_PF_TOO_LOW');
  if (weatherExact.directSLPct > config.maxWeatherDirectSLPct) reasons.push('EXACT_DAY_HOUR_WEATHER_DIRECT_SL_TOO_HIGH');
  if (diversityCount(diversity, 'distinctEntryDates', 'distinctDates') < config.minDistinctDates) {
    reasons.push('EXACT_DAY_HOUR_WEATHER_DATE_DIVERSITY_TOO_LOW');
  }
  if (diversityCount(diversity, 'distinctIsoWeeks') < config.minDistinctWeeks) {
    reasons.push('EXACT_DAY_HOUR_WEATHER_WEEK_DIVERSITY_TOO_LOW');
  }
  if (diversityCount(diversity, 'distinctSymbols') < config.minDistinctSymbols) {
    reasons.push('EXACT_DAY_HOUR_WEATHER_SYMBOL_DIVERSITY_TOO_LOW');
  }
  if (diversityCount(diversity, 'distinctMarketEventClusters') < config.minDistinctClusters) {
    reasons.push('EXACT_DAY_HOUR_WEATHER_CLUSTER_DIVERSITY_TOO_LOW');
  }
  if (config.requireDiversityPassed && diversity.passed !== true) {
    reasons.push('EXACT_DAY_HOUR_WEATHER_DIVERSITY_NOT_PASSED');
  }
  return reasons;
}

function observePreviewBaseWeatherReasons({
  row,
  projection,
  day,
  weatherKey,
  weatherExact,
  weatherBlended,
  dayProfile,
  sessionProfile
}) {
  const reasons = [];
  const gate = globalGateEvaluation(row);
  const global = globalMetric(row);
  if (!gate.acceptedForComposition) reasons.push('GLOBAL_GATE_NOT_PASSED_OR_OBSERVE_PREVIEW_NOT_MATURE');
  if (projectionDecision(dayProfile) === 'VETO_ACTIVE') reasons.push('DAY_VETO_ACTIVE');
  if (projectionDecision(sessionProfile) === 'VETO_ACTIVE') reasons.push('SESSION_VETO_ACTIVE');
  if (!weekendApproved(projection, day)) reasons.push('WEEKEND_NOT_APPROVED');
  if (weatherKey === 'UNKNOWN') reasons.push('UNKNOWN_MARKET_WEATHER_NOT_SELECTABLE');
  if (weatherExact.completed < OBSERVE_PREVIEW_MIN_EXACT_COMPLETED) {
    reasons.push('OBSERVE_EXACT_DAY_HOUR_WEATHER_EVIDENCE_MISSING');
  }
  if (weatherBlended.avgNetR < OBSERVE_PREVIEW_MIN_BLENDED_AVG_R) {
    reasons.push('OBSERVE_WEATHER_BLENDED_AVG_R_NOT_POSITIVE');
  }
  if (!gate.historicalContextDiscovery && global.avgNetR < OBSERVE_PREVIEW_MIN_AVG_R) {
    reasons.push('OBSERVE_GLOBAL_AVG_R_NOT_POSITIVE');
  }
  return reasons;
}

function counterBtcException({ exactBtc, diversity, config, btcState }) {
  if (!['BEARISH', 'STRONG_BEARISH'].includes(btcState)) {
    return { proven: false, required: false, reasons: [] };
  }
  const reasons = [];
  if (exactBtc.completed < config.counterMinCompleted) reasons.push('COUNTER_BTC_SAMPLE_TOO_SMALL');
  if (exactBtc.avgNetR < config.counterMinAvgR) reasons.push('COUNTER_BTC_AVG_R_TOO_LOW');
  if (exactBtc.lcb95 <= config.counterMinLcb95) reasons.push('COUNTER_BTC_LCB95_TOO_LOW');
  if (exactBtc.winrate < config.counterMinWinrate) reasons.push('COUNTER_BTC_WINRATE_TOO_LOW');
  if (exactBtc.profitFactor < config.counterMinProfitFactor) reasons.push('COUNTER_BTC_PF_TOO_LOW');
  if (diversityCount(diversity, 'distinctIsoWeeks') < config.minDistinctWeeks) {
    reasons.push('COUNTER_BTC_WEEK_DIVERSITY_TOO_LOW');
  }
  if (diversityCount(diversity, 'distinctSymbols') < config.minDistinctSymbols) {
    reasons.push('COUNTER_BTC_SYMBOL_DIVERSITY_TOO_LOW');
  }
  return {
    proven: reasons.length === 0,
    required: true,
    reasons
  };
}

function candidateForSlot({
  familyId,
  projection,
  row,
  day,
  hourUtc,
  marketWeatherKey,
  btcRouterState,
  mode
}) {
  const config = MODE_CONFIG[mode];
  const hourBucket = temporalHourKey(hourUtc);
  const weatherKey = temporalMarketWeatherKey(marketWeatherKey);
  const btcState = temporalBtcRouterKey(btcRouterState);
  const sessionBucket = sessionBucketForHour(hourUtc);

  const dayProfile = profileAt(projection, ['dayProfiles', day]);
  const sessionProfile = profileAt(projection, ['sessionProfiles', sessionBucket]);
  const hourProfile = profileAt(projection, ['hourProfiles', hourBucket]);
  const dayHourProfile = profileAt(projection, ['dayHourProfiles', day, hourBucket]);
  const weatherProfile = profileAt(projection, ['marketWeatherProfiles', weatherKey]);
  const dayWeatherProfile = profileAt(projection, ['dayWeatherProfiles', day, weatherKey]);
  const hourWeatherProfile = profileAt(projection, ['hourWeatherProfiles', hourBucket, weatherKey]);
  const dayHourWeatherProfile = profileAt(
    projection,
    ['dayHourWeatherProfiles', day, hourBucket, weatherKey]
  );
  const btcProfile = profileAt(projection, ['btcRouterProfiles', btcState]);
  const weatherBtcProfile = profileAt(projection, ['marketWeatherBtcProfiles', weatherKey, btcState]);
  const dayBtcProfile = profileAt(projection, ['dayBtcProfiles', day, btcState]);
  const hourBtcProfile = profileAt(projection, ['hourBtcProfiles', hourBucket, btcState]);
  const dayHourBtcProfile = profileAt(projection, ['dayHourBtcProfiles', day, hourBucket, btcState]);
  const dayWeatherBtcProfile = profileAt(
    projection,
    ['dayWeatherBtcProfiles', day, weatherKey, btcState]
  );
  const hourWeatherBtcProfile = profileAt(
    projection,
    ['hourWeatherBtcProfiles', hourBucket, weatherKey, btcState]
  );
  const exactBtcProfile = profileAt(
    projection,
    ['dayHourWeatherBtcProfiles', day, hourBucket, weatherKey, btcState]
  );

  const weatherExact = metric(dayHourWeatherProfile);
  const exactBtc = metric(exactBtcProfile);
  const hourWeather = metric(hourWeatherProfile);
  const dayWeather = metric(dayWeatherProfile);
  const weather = metric(weatherProfile);
  const dayHour = metric(dayHourProfile);
  const hour = metric(hourProfile);
  const dayMetric = metric(dayProfile);
  const session = metric(sessionProfile);
  const btc = metric(btcProfile);
  const weatherBtc = metric(weatherBtcProfile);
  const dayBtc = metric(dayBtcProfile);
  const hourBtc = metric(hourBtcProfile);
  const dayHourBtc = metric(dayHourBtcProfile);
  const dayWeatherBtc = metric(dayWeatherBtcProfile);
  const hourWeatherBtc = metric(hourWeatherBtcProfile);
  const global = globalMetric(row);

  const weatherBlended = weightedMetric([
    { metric: weatherExact, weight: Math.min(30, weatherExact.completed) * 4.0 },
    { metric: hourWeather, weight: Math.min(30, hourWeather.completed) * 1.35 },
    { metric: dayWeather, weight: Math.min(30, dayWeather.completed) * 1.20 },
    { metric: weather, weight: Math.min(40, weather.completed) * 0.90 },
    { metric: dayHour, weight: Math.min(30, dayHour.completed) * 0.80 },
    { metric: hour, weight: Math.min(30, hour.completed) * 0.40 },
    { metric: dayMetric, weight: Math.min(35, dayMetric.completed) * 0.40 },
    { metric: session, weight: Math.min(35, session.completed) * 0.30 },
    { metric: global, weight: Math.min(50, global.completed) * 0.25 }
  ]);

  const btcBlended = weightedMetric([
    { metric: exactBtc, weight: Math.min(30, exactBtc.completed) * 5.0 },
    { metric: hourWeatherBtc, weight: Math.min(30, hourWeatherBtc.completed) * 1.60 },
    { metric: dayWeatherBtc, weight: Math.min(30, dayWeatherBtc.completed) * 1.50 },
    { metric: dayHourBtc, weight: Math.min(30, dayHourBtc.completed) * 1.25 },
    { metric: weatherBtc, weight: Math.min(40, weatherBtc.completed) * 1.10 },
    { metric: hourBtc, weight: Math.min(35, hourBtc.completed) * 0.70 },
    { metric: dayBtc, weight: Math.min(35, dayBtc.completed) * 0.65 },
    { metric: btc, weight: Math.min(50, btc.completed) * 0.60 },
    { metric: weatherExact, weight: Math.min(30, weatherExact.completed) * 0.55 },
    { metric: global, weight: Math.min(50, global.completed) * 0.20 }
  ]);

  const diversity = diversityOf(exactBtcProfile);
  const weatherDiversity = diversityOf(dayHourWeatherProfile);
  const strictBeforeReasons = strictBaseWeatherReasons({
    row,
    projection,
    day,
    weatherKey,
    weatherExact,
    weatherBlended,
    diversity: weatherDiversity,
    config,
    dayProfile,
    sessionProfile
  });
  const observeBeforeReasons = observePreviewBaseWeatherReasons({
    row,
    projection,
    day,
    weatherKey,
    weatherExact,
    weatherBlended,
    dayProfile,
    sessionProfile
  });
  const strictBtcReasons = [];
  if (!BTC_SELECTABLE_SET.has(btcState)) strictBtcReasons.push('BTC_DIRECTION_UNKNOWN_OR_NOT_SELECTABLE');
  if (exactBtc.completed < config.minBtcCompleted) strictBtcReasons.push('EXACT_DAY_HOUR_WEATHER_BTC_SAMPLE_TOO_SMALL');
  if (exactBtc.avgNetR < config.minBtcAvgR) strictBtcReasons.push('EXACT_DAY_HOUR_WEATHER_BTC_AVG_R_TOO_LOW');
  if (exactBtc.lcb95 <= config.minBtcLcb95) strictBtcReasons.push('EXACT_DAY_HOUR_WEATHER_BTC_LCB95_TOO_LOW');
  if (exactBtc.winrate < config.minBtcWinrate) strictBtcReasons.push('EXACT_DAY_HOUR_WEATHER_BTC_WINRATE_TOO_LOW');
  if (exactBtc.profitFactor < config.minBtcProfitFactor) strictBtcReasons.push('EXACT_DAY_HOUR_WEATHER_BTC_PF_TOO_LOW');
  if (btcBlended.avgNetR < config.minBlendedAvgR) strictBtcReasons.push('BTC_BLENDED_AVG_R_TOO_LOW');
  if (diversityCount(diversity, 'distinctEntryDates', 'distinctDates') < config.minDistinctDates) {
    strictBtcReasons.push('EXACT_BTC_DATE_DIVERSITY_TOO_LOW');
  }
  if (diversityCount(diversity, 'distinctIsoWeeks') < config.minDistinctWeeks) {
    strictBtcReasons.push('EXACT_BTC_WEEK_DIVERSITY_TOO_LOW');
  }
  if (diversityCount(diversity, 'distinctSymbols') < config.minDistinctSymbols) {
    strictBtcReasons.push('EXACT_BTC_SYMBOL_DIVERSITY_TOO_LOW');
  }
  if (diversityCount(diversity, 'distinctMarketEventClusters') < config.minDistinctClusters) {
    strictBtcReasons.push('EXACT_BTC_CLUSTER_DIVERSITY_TOO_LOW');
  }
  if (config.requireDiversityPassed && diversity.passed !== true) {
    strictBtcReasons.push('EXACT_BTC_DIVERSITY_NOT_PASSED');
  }

  const exception = counterBtcException({ exactBtc, diversity, config, btcState });
  if (exception.required && !exception.proven) {
    strictBtcReasons.push(
      btcState === 'STRONG_BEARISH'
        ? 'BTC_STRONG_BEARISH_BLOCKS_LONG'
        : 'BTC_BEARISH_BLOCKS_LONG'
    );
    strictBtcReasons.push(...exception.reasons);
  }

  const observeBtcReasons = [];
  if (!BTC_SELECTABLE_SET.has(btcState)) {
    observeBtcReasons.push('BTC_DIRECTION_UNKNOWN_OR_NOT_SELECTABLE');
  }
  if (exactBtc.completed < OBSERVE_PREVIEW_MIN_EXACT_COMPLETED) {
    observeBtcReasons.push('OBSERVE_EXACT_BTC_EVIDENCE_MISSING');
  }
  if (btcBlended.avgNetR < OBSERVE_PREVIEW_MIN_BLENDED_AVG_R) {
    observeBtcReasons.push('OBSERVE_BTC_BLENDED_AVG_R_NOT_POSITIVE');
  }
  if (btcState === 'NEUTRAL' && (exactBtc.completed < 2 || exactBtc.avgNetR <= 0)) {
    observeBtcReasons.push('OBSERVE_NEUTRAL_BTC_NOT_PROVEN_POSITIVE');
  }
  if (exception.required && !exception.proven) {
    observeBtcReasons.push(
      btcState === 'STRONG_BEARISH'
        ? 'BTC_STRONG_BEARISH_BLOCKS_LONG'
        : 'BTC_BEARISH_BLOCKS_LONG'
    );
    observeBtcReasons.push(...exception.reasons);
  }

  const policyMode = compositionPolicyMode();
  const observePreviewMode = policyMode === 'OBSERVE';
  const beforeReasons = observePreviewMode ? observeBeforeReasons : strictBeforeReasons;
  const btcReasons = observePreviewMode ? observeBtcReasons : strictBtcReasons;
  const strictPublishEligible =
    strictBeforeReasons.length === 0 && strictBtcReasons.length === 0;

  const distinctWeeks = Math.max(1, diversityCount(diversity, 'distinctIsoWeeks'));
  const expectedSignalsPerWeek = clamp(exactBtc.completed / distinctWeeks, 0, 4);
  const sampleConfidence = clamp(exactBtc.completed / 35, 0, 1);
  const lowerBoundQuality = clamp((exactBtc.lcb95 + 0.10) / 0.40, 0, 1);
  const diversityQuality = clamp(
    (
      diversityCount(diversity, 'distinctEntryDates', 'distinctDates') / 12 +
      diversityCount(diversity, 'distinctIsoWeeks') / 8 +
      diversityCount(diversity, 'distinctSymbols') / 8 +
      diversityCount(diversity, 'distinctMarketEventClusters') / 12
    ) / 4,
    0,
    1
  );
  const confidenceScore = clamp(
    sampleConfidence * 45 + lowerBoundQuality * 35 + diversityQuality * 20,
    0,
    100
  );
  const expectedNetRPerWeek = expectedSignalsPerWeek * btcBlended.avgNetR;
  const expectedNetPnlPctPerWeek = expectedSignalsPerWeek * btcBlended.avgNetPnlPct;
  const btcAlignmentBonus = btcState === 'STRONG_BULLISH'
    ? 22
    : btcState === 'BULLISH'
      ? 12
      : btcState === 'NEUTRAL'
        ? 2
        : exception.proven
          ? 4
          : -40;

  const scoreByMode = {
    CONSERVATIVE:
      exactBtc.lcb95 * 380 +
      exactBtc.avgNetR * 180 +
      (exactBtc.winrate - 0.5) * 150 +
      Math.log1p(exactBtc.completed) * 7 +
      Math.min(exactBtc.profitFactor, 3) * 9 -
      exactBtc.directSLPct * 60 +
      confidenceScore * 0.22 +
      btcAlignmentBonus,
    BALANCED:
      btcBlended.avgNetR * 300 +
      exactBtc.avgNetR * 125 +
      (btcBlended.winrate - 0.5) * 120 +
      expectedNetRPerWeek * 95 +
      expectedNetPnlPctPerWeek * 4 +
      confidenceScore * 0.30 -
      btcBlended.directSLPct * 42 +
      btcAlignmentBonus,
    PERFORMANCE:
      expectedNetRPerWeek * 320 +
      expectedNetPnlPctPerWeek * 8 +
      btcBlended.avgNetR * 250 +
      exactBtc.avgNetR * 110 +
      (exactBtc.winrate - 0.5) * 80 +
      confidenceScore * 0.16 -
      exactBtc.avgCostR * 25 +
      btcAlignmentBonus
  };

  const taxonomy = familyTaxonomy(projection, row);
  const globalGate = globalGateEvaluation(row);
  return {
    familyId,
    eligibleBeforeBtcRouter: beforeReasons.length === 0,
    eligible: beforeReasons.length === 0 && btcReasons.length === 0,
    strictPublishEligible,
    observePreviewOnly: observePreviewMode && !strictPublishEligible,
    evidenceMode: observePreviewMode && !strictPublishEligible
      ? 'OBSERVE_HIERARCHICAL_BACKOFF_PREVIEW'
      : 'STRICT_EXACT_CONTEXT',
    compositionPolicyMode: policyMode,
    globalGate,
    strictPreBtcRejectionReasons: strictBeforeReasons,
    strictBtcRouterRejectionReasons: strictBtcReasons,
    preBtcRejectionReasons: beforeReasons,
    btcRouterRejectionReasons: btcReasons,
    rejectionReasons: [...beforeReasons, ...btcReasons],
    mode,
    day,
    hourUtc,
    hourBucket,
    marketWeatherKey: weatherKey,
    btcRouterState: btcState,
    btcDirection: ['STRONG_BULLISH', 'BULLISH'].includes(btcState)
      ? 'LONG'
      : ['STRONG_BEARISH', 'BEARISH'].includes(btcState)
        ? 'SHORT'
        : btcState === 'NEUTRAL'
          ? 'NEUTRAL'
          : 'UNKNOWN',
    btcAgainstLong: ['STRONG_BEARISH', 'BEARISH'].includes(btcState),
    counterBtcException: exception,
    sessionBucket,
    score: finite(scoreByMode[mode], -1_000_000),
    expectedSignalsPerWeek,
    expectedNetRPerWeek,
    expectedNetPnlPctPerWeek,
    confidenceScore,
    exact: exactBtc,
    exactBtc,
    exactWeather: weatherExact,
    blended: btcBlended,
    weatherBlended,
    diversity,
    weatherDiversity,
    historicalCorrelationCluster: row.historicalCorrelationCluster || null,
    maxPeerCorrelation: finite(row.maxPeerCorrelation, 0),
    ...taxonomy
  };
}


function compactSelectedFamilyEvidence(candidate = {}) {
  const exact = metric(candidate.exact || candidate.exactBtc || {});
  const blended = metric(candidate.blended || {});
  return {
    familyId: candidate.familyId || null,
    setupType: candidate.setupType || null,
    regimeBucket: candidate.regimeBucket || null,
    confirmationProfile: candidate.confirmationProfile || null,
    score: finite(candidate.score, 0),
    expectedSignalsPerWeek: finite(candidate.expectedSignalsPerWeek, 0),
    expectedNetRPerWeek: finite(candidate.expectedNetRPerWeek, 0),
    expectedNetPnlPctPerWeek: finite(candidate.expectedNetPnlPctPerWeek, 0),
    confidenceScore: finite(candidate.confidenceScore, 0),
    historicalCorrelationCluster: candidate.historicalCorrelationCluster || null,
    maxPeerCorrelation: finite(candidate.maxPeerCorrelation, 0),
    observePreviewOnly: candidate.observePreviewOnly === true,
    strictPublishEligible: candidate.strictPublishEligible === true,
    evidenceMode: candidate.evidenceMode || 'STRICT_EXACT_CONTEXT',
    compositionPolicyMode: candidate.compositionPolicyMode || compositionPolicyMode(),
    globalGate: candidate.globalGate
      ? {
          status: candidate.globalGate.status || null,
          completed: finite(candidate.globalGate.completed, 0),
          avgR: finite(candidate.globalGate.avgR, 0),
          strictPassed: candidate.globalGate.strictPassed === true,
          observePreviewPassed: candidate.globalGate.observePreviewPassed === true,
          empiricalVeto: candidate.globalGate.empiricalVeto === true,
          historicalContextDiscovery: candidate.globalGate.historicalContextDiscovery === true
        }
      : null,
    counterBtcException: candidate.counterBtcException
      ? {
          required: candidate.counterBtcException.required === true,
          proven: candidate.counterBtcException.proven === true,
          reasons: Array.isArray(candidate.counterBtcException.reasons)
            ? candidate.counterBtcException.reasons.slice(0, 12)
            : []
        }
      : { required: false, proven: false, reasons: [] },
    exact: {
      completed: exact.completed,
      wins: exact.wins,
      losses: exact.losses,
      flats: exact.flats,
      avgNetR: exact.avgNetR,
      totalR: exact.totalR,
      avgNetPnlPct: exact.avgNetPnlPct,
      totalNetPnlPct: exact.totalNetPnlPct,
      lcb95: exact.lcb95,
      ucb95: exact.ucb95,
      winrate: exact.winrate,
      profitFactor: exact.profitFactor,
      directSLPct: exact.directSLPct,
      avgCostR: exact.avgCostR
    },
    blended: {
      avgNetR: blended.avgNetR,
      avgNetPnlPct: blended.avgNetPnlPct,
      winrate: blended.winrate,
      directSLPct: blended.directSLPct,
      avgCostR: blended.avgCostR
    }
  };
}

function diversifiedSelection(candidates = [], config, eligibilityField = 'eligible') {
  const remaining = candidates
    .filter((candidate) => candidate?.[eligibilityField] === true)
    .sort((left, right) => right.score - left.score);
  const selected = [];
  while (remaining.length > 0 && selected.length < config.maxFamiliesPerSlot) {
    let bestIndex = -1;
    let bestAdjusted = -Infinity;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index];
      let penalty = 0;
      for (const existing of selected) {
        if (candidate.setupType && candidate.setupType === existing.setupType) penalty += 9;
        if (candidate.regimeBucket && candidate.regimeBucket === existing.regimeBucket) penalty += 6;
        if (
          candidate.confirmationProfile &&
          candidate.confirmationProfile === existing.confirmationProfile
        ) penalty += 4;
        if (candidate.historicalCorrelationCluster && candidate.historicalCorrelationCluster === existing.historicalCorrelationCluster) penalty += 14;
        if (Math.max(finite(candidate.maxPeerCorrelation, 0), finite(existing.maxPeerCorrelation, 0)) >= 0.85) penalty += 3;
      }
      const adjusted = candidate.score - penalty;
      if (adjusted > bestAdjusted) {
        bestAdjusted = adjusted;
        bestIndex = index;
      }
    }
    if (bestIndex < 0 || bestAdjusted < config.minimumPositiveScore) break;
    selected.push(remaining.splice(bestIndex, 1)[0]);
  }
  return selected;
}

function slotSummary(selected = []) {
  const completed = selected.reduce((sum, row) => sum + row.exact.completed, 0);
  const wins = selected.reduce((sum, row) => sum + row.exact.wins, 0);
  const grossWinR = selected.reduce((sum, row) => sum + row.exact.grossWinR, 0);
  const grossLossR = selected.reduce((sum, row) => sum + row.exact.grossLossR, 0);
  const totalR = selected.reduce((sum, row) => sum + row.exact.totalR, 0);
  const totalNetPnlPct = selected.reduce(
    (sum, row) => sum + row.exact.totalNetPnlPct,
    0
  );
  const expectedSignalsPerWeek = selected.reduce(
    (sum, row) => sum + row.expectedSignalsPerWeek,
    0
  );
  const expectedNetRPerWeek = selected.reduce(
    (sum, row) => sum + row.expectedNetRPerWeek,
    0
  );
  const expectedNetPnlPctPerWeek = selected.reduce(
    (sum, row) => sum + row.expectedNetPnlPctPerWeek,
    0
  );
  const confidenceWeight = selected.reduce(
    (sum, row) => sum + Math.max(0.01, row.expectedSignalsPerWeek),
    0
  );
  const confidenceScore = confidenceWeight > 0
    ? selected.reduce(
        (sum, row) =>
          sum + row.confidenceScore * Math.max(0.01, row.expectedSignalsPerWeek),
        0
      ) / confidenceWeight
    : 0;
  return {
    selectedFamilyCount: selected.length,
    historicalCompleted: completed,
    historicalWins: wins,
    historicalWinrate: completed > 0 ? wins / completed : 0,
    historicalTotalNetR: totalR,
    historicalAvgNetR: completed > 0 ? totalR / completed : 0,
    historicalTotalNetPnlPct: totalNetPnlPct,
    historicalAvgNetPnlPct: completed > 0 ? totalNetPnlPct / completed : 0,
    historicalProfitFactor: grossLossR > 0
      ? grossWinR / grossLossR
      : grossWinR > 0
        ? 999
        : 0,
    expectedSignalsPerWeek,
    expectedNetRPerWeek,
    expectedNetPnlPctPerWeek,
    confidenceScore
  };
}

function topRejectedReasons(candidates = []) {
  return Object.entries(
    candidates
      .filter((row) => !row.eligible)
      .flatMap((row) => row.rejectionReasons)
      .reduce((acc, reason) => {
        acc[reason] = (acc[reason] || 0) + 1;
        return acc;
      }, {})
  )
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8)
    .map(([reason, count]) => ({ reason, count }));
}

function buildSlot({
  day,
  hourUtc,
  marketWeatherKey,
  btcRouterState,
  mode,
  projectionMap,
  rows
}) {
  const config = MODE_CONFIG[mode];
  const weatherKey = temporalMarketWeatherKey(marketWeatherKey);
  const btcState = temporalBtcRouterKey(btcRouterState);
  const candidates = [];
  for (const [familyId, projection] of projectionMap.entries()) {
    const row = rows.get(familyId) || {};
    candidates.push(candidateForSlot({
      familyId,
      projection,
      row,
      day,
      hourUtc,
      marketWeatherKey: weatherKey,
      btcRouterState: btcState,
      mode
    }));
  }
  const preBtcSelected = diversifiedSelection(candidates, config, 'eligibleBeforeBtcRouter');
  const selected = diversifiedSelection(candidates, config, 'eligible');
  const key = slotKey(day, hourUtc, weatherKey, btcState);
  const common = {
    key,
    day,
    hourUtc,
    hourBucket: temporalHourKey(hourUtc),
    hourLabelUtc:
      `${String(hourUtc).padStart(2, '0')}:00-${String((hourUtc + 1) % 24).padStart(2, '0')}:00 UTC`,
    marketWeatherKey: weatherKey,
    btcRouterState: btcState,
    sessionBucket: sessionBucketForHour(hourUtc),
    candidateCount: candidates.length,
    preBtcEligibleCandidateCount: candidates.filter((row) => row.eligibleBeforeBtcRouter).length,
    eligibleCandidateCount: candidates.filter((row) => row.eligible).length,
    preBtcStats: slotSummary(preBtcSelected),
    preBtcSelectedFamilyIds: preBtcSelected.map((row) => row.familyId),
    btcRouterBlockedCandidateCount: candidates.filter(
      (row) => row.eligibleBeforeBtcRouter && !row.eligible
    ).length,
    counterBtcExceptionCandidateCount: candidates.filter(
      (row) => row.counterBtcException?.proven === true
    ).length,
    observePreviewCandidateCount: candidates.filter(
      (row) => row.observePreviewOnly === true && row.eligible === true
    ).length,
    strictPublishEligibleCandidateCount: candidates.filter(
      (row) => row.strictPublishEligible === true
    ).length,
    compositionPolicyMode: compositionPolicyMode()
  };
  if (selected.length === 0) {
    const routerBlocked = preBtcSelected.length > 0;
    return {
      ...common,
      enabled: false,
      reason: weatherKey === 'UNKNOWN'
        ? 'OFF_UNKNOWN_MARKET_WEATHER'
        : btcState === 'UNKNOWN'
          ? 'OFF_UNKNOWN_BTC_DIRECTION'
          : routerBlocked
            ? 'OFF_BTC_DIRECTION_ROUTER'
            : 'OFF_NO_QUALIFIED_FAMILY',
      topRejectedReasons: topRejectedReasons(candidates)
    };
  }
  const counterBtcExceptionFamilyIds = selected
    .filter((row) => row.counterBtcException?.proven === true)
    .map((row) => row.familyId);
  const observePreviewFamilyIds = selected
    .filter((row) => row.observePreviewOnly === true)
    .map((row) => row.familyId);
  const strictPublishEligibleFamilyIds = selected
    .filter((row) => row.strictPublishEligible === true)
    .map((row) => row.familyId);
  return {
    ...common,
    enabled: true,
    observePreviewOnly: observePreviewFamilyIds.length > 0,
    publishEligible: observePreviewFamilyIds.length === 0 && strictPublishEligibleFamilyIds.length > 0,
    reason: counterBtcExceptionFamilyIds.length > 0
      ? 'QUALIFIED_WITH_PROVEN_COUNTER_BTC_EXCEPTION'
      : observePreviewFamilyIds.length > 0
        ? 'OBSERVE_PREVIEW_HIERARCHICAL_BACKOFF'
        : 'QUALIFIED_FAMILIES_SELECTED',
    selectedFamilyIds: selected.map((row) => row.familyId),
    observePreviewFamilyIds,
    strictPublishEligibleFamilyIds,
    selectedFamilies: selected.map(compactSelectedFamilyEvidence),
    counterBtcExceptionFamilyIds,
    btcRouterDecision: {
      state: btcState,
      longDirectionAllowed: !['BEARISH', 'STRONG_BEARISH'].includes(btcState) ||
        counterBtcExceptionFamilyIds.length > 0,
      againstLong: ['BEARISH', 'STRONG_BEARISH'].includes(btcState),
      provenCounterExceptionUsed: counterBtcExceptionFamilyIds.length > 0,
      profileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
      policyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION
    },
    stats: slotSummary(selected)
  };
}

function aggregateSummaryFromSlots(slots = {}) {
  const enabledSlots = Object.values(slots || {}).filter((slot) => slot?.enabled === true);
  const familyUnion = [...new Set(enabledSlots.flatMap((slot) => slot.selectedFamilyIds || []))]
    .sort();
  const historicalCompleted = enabledSlots.reduce(
    (sum, slot) => sum + finite(slot.stats?.historicalCompleted, 0),
    0
  );
  const historicalWins = enabledSlots.reduce(
    (sum, slot) => sum + finite(slot.stats?.historicalWins, 0),
    0
  );
  const historicalTotalNetR = enabledSlots.reduce(
    (sum, slot) => sum + finite(slot.stats?.historicalTotalNetR, 0),
    0
  );
  const historicalTotalNetPnlPct = enabledSlots.reduce(
    (sum, slot) => sum + finite(slot.stats?.historicalTotalNetPnlPct, 0),
    0
  );
  const expectedSignalsPerWeek = enabledSlots.reduce(
    (sum, slot) => sum + finite(slot.stats?.expectedSignalsPerWeek, 0),
    0
  );
  const expectedNetRPerWeek = enabledSlots.reduce(
    (sum, slot) => sum + finite(slot.stats?.expectedNetRPerWeek, 0),
    0
  );
  const expectedNetPnlPctPerWeek = enabledSlots.reduce(
    (sum, slot) => sum + finite(slot.stats?.expectedNetPnlPctPerWeek, 0),
    0
  );
  const confidenceWeight = enabledSlots.reduce(
    (sum, slot) => sum + Math.max(0.01, finite(slot.stats?.expectedSignalsPerWeek, 0)),
    0
  );
  const confidenceScore = confidenceWeight > 0
    ? enabledSlots.reduce(
        (sum, slot) =>
          sum +
          finite(slot.stats?.confidenceScore, 0) *
            Math.max(0.01, finite(slot.stats?.expectedSignalsPerWeek, 0)),
        0
      ) / confidenceWeight
    : 0;

  const daySummaries = Object.fromEntries(
    TEMPORAL_DAY_BUCKETS.map((day) => {
      const rows = enabledSlots.filter((slot) => slot.day === day);
      return [day, {
        activeWeatherBtcHourSlots: rows.length,
        activeHours: [...new Set(rows.map((slot) => slot.hourBucket))].sort(),
        activeWeatherKeys: [...new Set(rows.map((slot) => slot.marketWeatherKey))].sort(),
        activeBtcStates: [...new Set(rows.map((slot) => slot.btcRouterState))].sort(),
        familyIds: [...new Set(rows.flatMap((slot) => slot.selectedFamilyIds || []))].sort(),
        expectedSignalsPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedSignalsPerWeek, 0),
          0
        ),
        expectedNetRPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedNetRPerWeek, 0),
          0
        ),
        expectedNetPnlPctPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedNetPnlPctPerWeek, 0),
          0
        )
      }];
    })
  );

  const weatherSummaries = Object.fromEntries(
    TEMPORAL_MARKET_WEATHER_KEYS.map((weatherKey) => {
      const rows = enabledSlots.filter((slot) => slot.marketWeatherKey === weatherKey);
      return [weatherKey, {
        activeSlots: rows.length,
        activeBtcStates: [...new Set(rows.map((slot) => slot.btcRouterState))].sort(),
        familyIds: [...new Set(rows.flatMap((slot) => slot.selectedFamilyIds || []))].sort(),
        expectedSignalsPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedSignalsPerWeek, 0),
          0
        ),
        expectedNetRPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedNetRPerWeek, 0),
          0
        ),
        expectedNetPnlPctPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedNetPnlPctPerWeek, 0),
          0
        )
      }];
    })
  );

  const btcSummaries = Object.fromEntries(
    BTC_ROUTER_STATES.map((btcState) => {
      const rows = enabledSlots.filter((slot) => slot.btcRouterState === btcState);
      const completed = rows.reduce((sum, slot) => sum + finite(slot.stats?.historicalCompleted, 0), 0);
      const wins = rows.reduce((sum, slot) => sum + finite(slot.stats?.historicalWins, 0), 0);
      const totalR = rows.reduce((sum, slot) => sum + finite(slot.stats?.historicalTotalNetR, 0), 0);
      const totalPnl = rows.reduce((sum, slot) => sum + finite(slot.stats?.historicalTotalNetPnlPct, 0), 0);
      return [btcState, {
        activeSlots: rows.length,
        familyIds: [...new Set(rows.flatMap((slot) => slot.selectedFamilyIds || []))].sort(),
        counterBtcExceptionSlots: rows.filter(
          (slot) => (slot.counterBtcExceptionFamilyIds || []).length > 0
        ).length,
        historicalCompleted: completed,
        historicalWinrate: completed > 0 ? wins / completed : 0,
        historicalAvgNetR: completed > 0 ? totalR / completed : 0,
        historicalAvgNetPnlPct: completed > 0 ? totalPnl / completed : 0,
        expectedSignalsPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedSignalsPerWeek, 0),
          0
        ),
        expectedNetRPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedNetRPerWeek, 0),
          0
        ),
        expectedNetPnlPctPerWeek: rows.reduce(
          (sum, slot) => sum + finite(slot.stats?.expectedNetPnlPctPerWeek, 0),
          0
        )
      }];
    })
  );

  return {
    totalPossibleSlots:
      TEMPORAL_DAY_BUCKETS.length * TEMPORAL_HOUR_BUCKETS.length *
      TEMPORAL_MARKET_WEATHER_KEYS.length * BTC_ROUTER_STATES.length,
    activeSlots: enabledSlots.length,
    activeDayHours: new Set(enabledSlots.map((slot) => `${slot.day}:${slot.hourBucket}`)).size,
    familyUnion,
    familyCount: familyUnion.length,
    historicalCompleted,
    historicalWins,
    historicalWinrate: historicalCompleted > 0
      ? historicalWins / historicalCompleted
      : 0,
    historicalTotalNetR,
    historicalAvgNetR: historicalCompleted > 0
      ? historicalTotalNetR / historicalCompleted
      : 0,
    historicalTotalNetPnlPct,
    historicalAvgNetPnlPct: historicalCompleted > 0
      ? historicalTotalNetPnlPct / historicalCompleted
      : 0,
    expectedSignalsPerWeek,
    expectedNetRPerWeek,
    expectedNetPnlPctPerWeek,
    confidenceScore,
    counterBtcExceptionSlots: enabledSlots.filter(
      (slot) => (slot.counterBtcExceptionFamilyIds || []).length > 0
    ).length,
    observePreviewSlots: enabledSlots.filter(
      (slot) => slot.observePreviewOnly === true
    ).length,
    strictPublishEligibleSlots: enabledSlots.filter(
      (slot) => slot.publishEligible === true
    ).length,
    daySummaries,
    weatherSummaries,
    btcSummaries
  };
}

export function summarizeWeekComposition(composition = {}) {
  return aggregateSummaryFromSlots(composition.slots || {});
}

function exactEvidenceSlotKeys(generation = {}) {
  const keys = new Set();
  for (const projection of generation.familyProjections || []) {
    for (const day of TEMPORAL_DAY_BUCKETS) {
      for (const hourBucket of TEMPORAL_HOUR_BUCKETS) {
        const byWeather = projection?.dayHourWeatherBtcProfiles?.[day]?.[hourBucket] || {};
        for (const [weatherKey, byBtc] of Object.entries(byWeather)) {
          for (const [btcState, profile] of Object.entries(byBtc || {})) {
            if (metric(profile).completed <= 0) continue;
            keys.add(slotKey(day, Number(hourBucket.slice(1)), weatherKey, btcState));
          }
        }
      }
    }
  }
  return [...keys].sort();
}

function impactAccumulator() {
  return {
    evidenceSlotsEvaluated: 0,
    preFilterActiveSlots: 0,
    postFilterActiveSlots: 0,
    slotsBlockedByBtcRouter: 0,
    preFilterHistoricalCompleted: 0,
    preFilterHistoricalWins: 0,
    preFilterHistoricalTotalNetR: 0,
    preFilterHistoricalTotalNetPnlPct: 0,
    preFilterExpectedSignalsPerWeek: 0,
    preFilterExpectedNetRPerWeek: 0,
    preFilterExpectedNetPnlPctPerWeek: 0,
    postFilterHistoricalCompleted: 0,
    postFilterHistoricalWins: 0,
    postFilterHistoricalTotalNetR: 0,
    postFilterHistoricalTotalNetPnlPct: 0,
    postFilterExpectedSignalsPerWeek: 0,
    postFilterExpectedNetRPerWeek: 0,
    postFilterExpectedNetPnlPctPerWeek: 0
  };
}

function addStatsToImpact(target, prefix, stats = {}) {
  target[`${prefix}HistoricalCompleted`] += finite(stats.historicalCompleted, 0);
  target[`${prefix}HistoricalWins`] += finite(stats.historicalWins, 0);
  target[`${prefix}HistoricalTotalNetR`] += finite(stats.historicalTotalNetR, 0);
  target[`${prefix}HistoricalTotalNetPnlPct`] += finite(stats.historicalTotalNetPnlPct, 0);
  target[`${prefix}ExpectedSignalsPerWeek`] += finite(stats.expectedSignalsPerWeek, 0);
  target[`${prefix}ExpectedNetRPerWeek`] += finite(stats.expectedNetRPerWeek, 0);
  target[`${prefix}ExpectedNetPnlPctPerWeek`] += finite(stats.expectedNetPnlPctPerWeek, 0);
}

function finalizeImpact(impact) {
  const preN = impact.preFilterHistoricalCompleted;
  const postN = impact.postFilterHistoricalCompleted;
  return {
    ...impact,
    preFilterHistoricalWinrate: preN > 0 ? impact.preFilterHistoricalWins / preN : 0,
    preFilterHistoricalAvgNetR: preN > 0 ? impact.preFilterHistoricalTotalNetR / preN : 0,
    preFilterHistoricalAvgNetPnlPct: preN > 0 ? impact.preFilterHistoricalTotalNetPnlPct / preN : 0,
    postFilterHistoricalWinrate: postN > 0 ? impact.postFilterHistoricalWins / postN : 0,
    postFilterHistoricalAvgNetR: postN > 0 ? impact.postFilterHistoricalTotalNetR / postN : 0,
    postFilterHistoricalAvgNetPnlPct: postN > 0 ? impact.postFilterHistoricalTotalNetPnlPct / postN : 0,
    winrateDelta: (postN > 0 ? impact.postFilterHistoricalWins / postN : 0) -
      (preN > 0 ? impact.preFilterHistoricalWins / preN : 0),
    avgNetRDelta: (postN > 0 ? impact.postFilterHistoricalTotalNetR / postN : 0) -
      (preN > 0 ? impact.preFilterHistoricalTotalNetR / preN : 0),
    avgNetPnlPctDelta: (postN > 0 ? impact.postFilterHistoricalTotalNetPnlPct / postN : 0) -
      (preN > 0 ? impact.preFilterHistoricalTotalNetPnlPct / preN : 0)
  };
}

function buildComposition({ mode, generation, micros }) {
  const config = MODE_CONFIG[mode];
  const projectionMap = projectionMapOf(generation);
  const rows = familyRowMap(micros);
  const slots = {};
  const offReasonCounts = {};
  const evidenceKeys = exactEvidenceSlotKeys(generation);
  const impact = impactAccumulator();

  for (const key of evidenceKeys) {
    const parsed = parseSlotKey(key);
    impact.evidenceSlotsEvaluated += 1;
    const slot = buildSlot({
      day: parsed.day,
      hourUtc: parsed.hourUtc,
      marketWeatherKey: parsed.marketWeatherKey,
      btcRouterState: parsed.btcRouterState,
      mode,
      projectionMap,
      rows
    });
    if (slot.preBtcSelectedFamilyIds?.length > 0) {
      impact.preFilterActiveSlots += 1;
      addStatsToImpact(impact, 'preFilter', slot.preBtcStats);
    }
    if (slot.enabled) {
      impact.postFilterActiveSlots += 1;
      addStatsToImpact(impact, 'postFilter', slot.stats);
      slots[slot.key] = slot;
    } else {
      if (slot.reason === 'OFF_BTC_DIRECTION_ROUTER') impact.slotsBlockedByBtcRouter += 1;
      offReasonCounts[slot.reason] = (offReasonCounts[slot.reason] || 0) + 1;
      for (const reason of slot.topRejectedReasons || []) {
        offReasonCounts[reason.reason] =
          (offReasonCounts[reason.reason] || 0) + reason.count;
      }
    }
  }

  const totalPossibleSlots =
    TEMPORAL_DAY_BUCKETS.length * TEMPORAL_HOUR_BUCKETS.length *
    TEMPORAL_MARKET_WEATHER_KEYS.length * BTC_ROUTER_STATES.length;
  offReasonCounts.OFF_NO_EXACT_BTC_EVIDENCE = Math.max(
    0,
    totalPossibleSlots - evidenceKeys.length
  );
  const btcRouterImpact = finalizeImpact(impact);

  const base = {
    compositionVersion: WEEK_COMPOSITION_VERSION,
    optimizerVersion: WEEK_COMPOSITION_OPTIMIZER_VERSION,
    btcDirectionRouterProfileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
    btcDirectionRouterPolicyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION,
    compositionId: `${generation.generationId}:${mode}`,
    baseCompositionId: `${generation.generationId}:${mode}`,
    generationId: generation.generationId,
    generationCutoffTs: generation.generationCutoffTs,
    mode,
    rank: config.rank,
    title: config.title,
    description: config.description,
    status: 'PROPOSED',
    compositionPolicyMode: compositionPolicyMode(),
    observePreviewEnabled: compositionPolicyMode() === 'OBSERVE',
    observePreviewDoesNotOverrideGlobalDiscordGate: true,
    observePreviewDoesNotEnableCounterBtcWithoutProof: true,
    timezone: 'UTC',
    dimensions: {
      days: TEMPORAL_DAY_BUCKETS,
      hours: TEMPORAL_HOUR_BUCKETS,
      marketWeatherKeys: TEMPORAL_MARKET_WEATHER_KEYS,
      btcRouterStates: BTC_ROUTER_STATES,
      btcSelectableStates: BTC_ROUTER_SELECTABLE_STATES,
      totalPossibleSlots
    },
    thresholds: deepClone(config),
    slots,
    absentSlotMeaning: 'OFF_NO_QUALIFIED_FAMILY_OR_NO_EXACT_BTC_EVIDENCE',
    offReasonCounts,
    evaluatedSlotCount: totalPossibleSlots,
    evidenceSlotCount: evidenceKeys.length,
    btcRouterImpact,
    overrides: {
      disabledDays: [],
      disabledHours: [],
      disabledWeatherKeys: [],
      disabledBtcStates: [],
      disabledWeatherBtcKeys: [],
      disabledDayHours: [],
      disabledSlotWeatherKeys: [],
      disabledDayHourWeatherBtcKeys: []
    },
    createdAt: Date.now(),
    activatedAt: null,
    activatedBy: null,
    checksum: null
  };
  base.summary = {
    ...summarizeWeekComposition(base),
    btcRouterImpact
  };
  base.checksum = checksum(base);
  return base;
}

export function buildWeekCompositionProposals({ generation, micros = {} } = {}) {
  if (!generation?.generationId) return [];
  return WEEK_COMPOSITION_MODES.map((mode) =>
    buildComposition({ mode, generation, micros })
  );
}

function normalizeStringSet(values = []) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => upper(value))
      .filter(Boolean)
  );
}

function weatherBtcKey(weatherKey, btcState) {
  return `${temporalMarketWeatherKey(weatherKey)}|BTC:${temporalBtcRouterKey(btcState)}`;
}

function disabledByOverrides(slot = {}, overrides = {}) {
  const disabledDays = normalizeStringSet(overrides.disabledDays);
  const disabledHoursSet = normalizeStringSet(overrides.disabledHours);
  const disabledHours = disabledHoursSet.has(slot.hourBucket) ||
    disabledHoursSet.has(String(slot.hourUtc));
  const disabledWeather = normalizeStringSet(overrides.disabledWeatherKeys)
    .has(slot.marketWeatherKey);
  const disabledBtc = normalizeStringSet(overrides.disabledBtcStates)
    .has(slot.btcRouterState);
  const disabledWeatherBtc = normalizeStringSet(overrides.disabledWeatherBtcKeys)
    .has(weatherBtcKey(slot.marketWeatherKey, slot.btcRouterState));
  const disabledDayHours = normalizeStringSet(overrides.disabledDayHours)
    .has(`${slot.day}:${slot.hourBucket}`);
  const disabledExactLegacy = normalizeStringSet(overrides.disabledSlotWeatherKeys)
    .has(slot.key);
  const disabledExact = normalizeStringSet(overrides.disabledDayHourWeatherBtcKeys)
    .has(slot.key);
  return disabledDays.has(slot.day) || disabledHours || disabledWeather ||
    disabledBtc || disabledWeatherBtc || disabledDayHours ||
    disabledExactLegacy || disabledExact;
}

export function applyWeekCompositionOverrides(baseComposition = {}, {
  disabledDays = [],
  disabledHours = [],
  disabledWeatherKeys = [],
  disabledBtcStates = [],
  disabledWeatherBtcKeys = [],
  disabledDayHours = [],
  disabledSlots = [],
  disabledSlotWeatherKeys = [],
  disabledDayHourWeatherBtcKeys = [],
  activatedBy = 'ADMIN_WEEK_COMPOSITION'
} = {}) {
  const composition = deepClone(baseComposition);
  const legacyExact = [
    ...(Array.isArray(disabledSlotWeatherKeys) ? disabledSlotWeatherKeys : [disabledSlotWeatherKeys]),
    ...(Array.isArray(disabledDayHourWeatherBtcKeys)
      ? disabledDayHourWeatherBtcKeys
      : [disabledDayHourWeatherBtcKeys])
  ];
  const overrides = {
    disabledDays: [...normalizeStringSet(disabledDays)].filter((day) => DAY_SET.has(day)),
    disabledHours: [...normalizeStringSet(disabledHours)]
      .map((value) => value.startsWith('H') ? value : temporalHourKey(value))
      .filter((hour) => HOUR_SET.has(hour)),
    disabledWeatherKeys: [...normalizeStringSet(disabledWeatherKeys)]
      .map((value) => temporalMarketWeatherKey(value))
      .filter((weather) => WEATHER_SET.has(weather)),
    disabledBtcStates: [...normalizeStringSet(disabledBtcStates)]
      .map((value) => temporalBtcRouterKey(value))
      .filter((state) => BTC_SET.has(state)),
    disabledWeatherBtcKeys: [...normalizeStringSet(disabledWeatherBtcKeys)]
      .filter((value) => {
        const marker = value.lastIndexOf('|BTC:');
        if (marker < 0) return false;
        return WEATHER_SET.has(temporalMarketWeatherKey(value.slice(0, marker))) &&
          BTC_SET.has(temporalBtcRouterKey(value.slice(marker + 5)));
      }),
    disabledDayHours: [...normalizeStringSet([
      ...(Array.isArray(disabledDayHours) ? disabledDayHours : [disabledDayHours]),
      ...(Array.isArray(disabledSlots) ? disabledSlots : [disabledSlots])
    ])]
      .map((value) => value.replace('|', ':'))
      .filter((value) => {
        const [day, hour] = value.split(':');
        return DAY_SET.has(day) && HOUR_SET.has(hour);
      }),
    disabledSlotWeatherKeys: [...normalizeStringSet(legacyExact)]
      .filter((value) => {
        const parsed = parseSlotKey(value);
        return DAY_SET.has(parsed.day) && HOUR_SET.has(parsed.hourBucket) &&
          WEATHER_SET.has(parsed.marketWeatherKey) && BTC_SET.has(parsed.btcRouterState);
      }),
    disabledDayHourWeatherBtcKeys: [...normalizeStringSet(legacyExact)]
      .filter((value) => {
        const parsed = parseSlotKey(value);
        return DAY_SET.has(parsed.day) && HOUR_SET.has(parsed.hourBucket) &&
          WEATHER_SET.has(parsed.marketWeatherKey) && BTC_SET.has(parsed.btcRouterState);
      })
  };
  composition.slots = Object.fromEntries(
    Object.entries(composition.slots || {})
      .filter(([, slot]) => !disabledByOverrides(slot, overrides))
  );
  composition.baseCompositionId =
    baseComposition.baseCompositionId || baseComposition.compositionId;
  composition.compositionId = `${composition.baseCompositionId}:ACTIVE:${checksum(overrides).slice(0, 12)}`;
  composition.status = 'ACTIVE';
  composition.overrides = overrides;
  composition.activatedAt = Date.now();
  composition.activatedBy = activatedBy;
  composition.summary = {
    ...summarizeWeekComposition(composition),
    btcRouterImpact: baseComposition.btcRouterImpact || baseComposition.summary?.btcRouterImpact || null
  };
  composition.checksum = checksum(composition);
  return composition;
}

export function validateWeekComposition(composition = {}, {
  generationId = null,
  requireActive = false
} = {}) {
  const errors = [];
  if (!composition || typeof composition !== 'object') errors.push('WEEK_COMPOSITION_MISSING');
  if (composition?.compositionVersion !== WEEK_COMPOSITION_VERSION) {
    errors.push('WEEK_COMPOSITION_VERSION_MISMATCH');
  }
  if (composition?.optimizerVersion !== WEEK_COMPOSITION_OPTIMIZER_VERSION) {
    errors.push('WEEK_COMPOSITION_OPTIMIZER_VERSION_MISMATCH');
  }
  if (composition?.btcDirectionRouterProfileVersion !== BTC_DIRECTION_ROUTER_PROFILE_VERSION) {
    errors.push('BTC_DIRECTION_ROUTER_PROFILE_VERSION_MISMATCH');
  }
  if (composition?.btcDirectionRouterPolicyVersion !== BTC_DIRECTION_ROUTER_POLICY_VERSION) {
    errors.push('BTC_DIRECTION_ROUTER_POLICY_VERSION_MISMATCH');
  }
  if (!WEEK_COMPOSITION_MODES.includes(upper(composition?.mode))) {
    errors.push('WEEK_COMPOSITION_MODE_INVALID');
  }
  if (generationId && composition?.generationId !== generationId) {
    errors.push('WEEK_COMPOSITION_GENERATION_MISMATCH');
  }
  if (requireActive && composition?.status !== 'ACTIVE') {
    errors.push('WEEK_COMPOSITION_NOT_ACTIVE');
  }
  if (!composition?.slots || typeof composition.slots !== 'object' || Array.isArray(composition.slots)) {
    errors.push('WEEK_COMPOSITION_SLOTS_INVALID');
  } else {
    const maxFamilies = MODE_CONFIG[upper(composition.mode)]?.maxFamiliesPerSlot || 0;
    for (const [key, slot] of Object.entries(composition.slots)) {
      const parsed = parseSlotKey(key);
      if (!DAY_SET.has(parsed.day) || !HOUR_SET.has(parsed.hourBucket) ||
        !WEATHER_SET.has(parsed.marketWeatherKey) || !BTC_SET.has(parsed.btcRouterState)) {
        errors.push(`WEEK_COMPOSITION_SLOT_KEY_INVALID:${key}`);
        continue;
      }
      if (slot?.enabled !== true) errors.push(`WEEK_COMPOSITION_STORED_SLOT_NOT_ENABLED:${key}`);
      if (slot?.key !== key) errors.push(`WEEK_COMPOSITION_SLOT_KEY_MISMATCH:${key}`);
      if (slot?.btcRouterState !== parsed.btcRouterState) {
        errors.push(`WEEK_COMPOSITION_SLOT_BTC_STATE_MISMATCH:${key}`);
      }
      const familyIds = Array.isArray(slot?.selectedFamilyIds)
        ? slot.selectedFamilyIds
        : [];
      if (familyIds.length === 0 || familyIds.length > maxFamilies) {
        errors.push(`WEEK_COMPOSITION_SLOT_FAMILY_COUNT_INVALID:${key}`);
      }
      if (familyIds.some((id) => !exactFamilyId(id))) {
        errors.push(`WEEK_COMPOSITION_SLOT_FAMILY_ID_INVALID:${key}`);
      }
      if (['BEARISH', 'STRONG_BEARISH'].includes(parsed.btcRouterState)) {
        const exceptions = Array.isArray(slot.counterBtcExceptionFamilyIds)
          ? slot.counterBtcExceptionFamilyIds
          : [];
        if (exceptions.length === 0 || familyIds.some((id) => !exceptions.includes(id))) {
          errors.push(`COUNTER_BTC_SLOT_WITHOUT_PROVEN_EXCEPTION:${key}`);
        }
      }
    }
  }
  if (composition?.checksum !== checksum(composition)) {
    errors.push('WEEK_COMPOSITION_CHECKSUM_INVALID');
  }
  return {
    valid: errors.length === 0,
    errors,
    compositionId: composition?.compositionId || null,
    generationId: composition?.generationId || null,
    mode: composition?.mode || null,
    activeSlotCount: Object.keys(composition?.slots || {}).length,
    btcDirectionRouterProfileVersion: composition?.btcDirectionRouterProfileVersion || null
  };
}

export function evaluateWeekCompositionSlot(composition = null, {
  dayOfWeekUtc,
  hourUtc,
  marketWeatherKey,
  currentMarketWeather,
  currentRegime,
  currentTrendSide,
  btcRouterState,
  entryBtcRouterState,
  btcContext,
  row,
  familyId
} = {}) {
  if (!composition) {
    return {
      compositionApplied: false,
      allowed: true,
      reasons: [],
      slot: null,
      slotKey: null,
      marketWeatherKey: null,
      btcRouterState: null
    };
  }
  const weatherKey = temporalMarketWeatherKey(
    marketWeatherKey || currentMarketWeather || currentRegime,
    currentTrendSide
  );
  const resolvedBtc = resolveEntryBtcRouterContext({
    ...(row && typeof row === 'object' ? row : {}),
    ...(btcContext && typeof btcContext === 'object' ? btcContext : {}),
    entryBtcRouterState: entryBtcRouterState || btcRouterState ||
      btcContext?.btcRouterState || row?.entryBtcRouterState,
    entryMarketWeatherKey: weatherKey,
    entryMarketWeatherRegime: currentRegime,
    entryMarketWeatherTrendSide: currentTrendSide
  });
  const btcState = temporalBtcRouterKey(
    entryBtcRouterState || btcRouterState || resolvedBtc.btcRouterState
  );
  const key = slotKey(dayOfWeekUtc, hourUtc, weatherKey, btcState);
  const slot = composition.slots?.[key] || null;
  const reasons = [];
  if (weatherKey === 'UNKNOWN') reasons.push('WEEK_COMPOSITION_MARKET_WEATHER_UNKNOWN');
  if (btcState === 'UNKNOWN') reasons.push('BTC_DIRECTION_ROUTER_UNKNOWN_FAIL_CLOSED');
  if (!slot) reasons.push('WEEK_COMPOSITION_DAY_HOUR_WEATHER_BTC_SLOT_OFF');
  const normalizedFamilyId = exactFamilyId(familyId);
  if (slot && !slot.selectedFamilyIds?.includes(normalizedFamilyId)) {
    reasons.push('FAMILY_NOT_SELECTED_FOR_DAY_HOUR_MARKET_WEATHER_BTC');
  }
  if (
    slot && ['BEARISH', 'STRONG_BEARISH'].includes(btcState) &&
    !slot.counterBtcExceptionFamilyIds?.includes(normalizedFamilyId)
  ) {
    reasons.push('LONG_BLOCKED_AGAINST_BTC_WITHOUT_PROVEN_EXCEPTION');
  }
  return {
    compositionApplied: true,
    allowed: reasons.length === 0,
    reasons,
    slot,
    slotKey: key,
    marketWeatherKey: weatherKey,
    btcRouterState: btcState,
    btcRouterContext: resolvedBtc,
    btcAgainstLong: resolvedBtc.againstLong,
    counterBtcExceptionUsed: Boolean(
      slot?.counterBtcExceptionFamilyIds?.includes(normalizedFamilyId)
    ),
    dayOfWeekUtc: upper(dayOfWeekUtc),
    hourUtc: Math.max(0, Math.min(23, Math.floor(finite(hourUtc, 0)))),
    familyId: normalizedFamilyId,
    profileVersion: BTC_DIRECTION_ROUTER_PROFILE_VERSION,
    policyVersion: BTC_DIRECTION_ROUTER_POLICY_VERSION
  };
}
