// ================= FILE: scripts/validateSystem.js =================
//
// Volledige LONG-root validator.
//
// Controleert:
// - JavaScript-syntaxis;
// - lokale named-import/exportcontracten;
// - verplicht Analyze-contract;
// - LONG-root richting, Redis-isolatie en taxonomie;
// - actuele V2 measurement-, exit-fill- en empirical-vetoversies;
// - weekend- en UTC-sessiecontracten;
// - entry- en exitcontextvelden;
// - statische Discord-entryvoorwaarden;
// - bekende SHORT-productiedeclaraties die niet in een LONG-root thuishoren.
//
// De validator verandert geen bestanden en voert geen exchange-orders uit.

import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(currentFile), '..');
const currentFileNormalized = path.normalize(currentFile);

const SOURCE_DIRECTORIES = Object.freeze([
  'src',
  'api',
  'scripts'
]);

const PRODUCTION_DIRECTORIES = Object.freeze([
  'src',
  'api'
]);

const REQUIRED_ANALYZE_EXPORTS = Object.freeze([
  'analyzeCandidatesBatch',
  'buildOutcomeFromPosition',
  'recordOutcome',
  'getWeekMicros',
  'saveWeekMicros'
]);

const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';

const MEASUREMENT_FIX_VERSION =
  'LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2';
const EXIT_FILL_MODEL_VERSION =
  'LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1';
const EMPIRICAL_VETO_POLICY_VERSION =
  'LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1';

const TEMPORAL_CONTEXT_VERSION =
  'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION =
  'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION =
  'LONG_SESSION_OBSERVE_V1';

const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';

const REQUIRED_SESSION_BUCKETS = Object.freeze([
  'ASIA',
  'EUROPE',
  'US',
  'ASIA_EU_OVERLAP',
  'EU_US_OVERLAP',
  'OFF_HOURS'
]);

const REQUIRED_DAY_TYPES = Object.freeze([
  'WEEKDAY',
  'WEEKEND'
]);

const REQUIRED_DAY_NAMES = Object.freeze([
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY'
]);

const REQUIRED_ENTRY_CONTEXT_FIELDS = Object.freeze([
  'entryTs',
  'entryHourUtc',
  'entryDayOfWeekUtc',
  'entryDayType',
  'entryIsWeekend',
  'entrySessionTags',
  'entrySessionBucket',
  'entrySessionOverlap',
  'entryOffHours'
]);

const REQUIRED_EXIT_CONTEXT_FIELDS = Object.freeze([
  'exitTs',
  'exitHourUtc',
  'exitDayOfWeekUtc',
  'exitDayType',
  'exitIsWeekend',
  'exitSessionTags',
  'exitSessionBucket',
  'exitSessionOverlap',
  'exitOffHours'
]);

const REQUIRED_CONTEXT_STAT_BUCKETS = Object.freeze([
  'contextStats',
  'sessionStats',
  'WEEKDAY',
  'WEEKEND',
  ...REQUIRED_SESSION_BUCKETS
]);

const TEMPORAL_EXPORT_CANDIDATES = Object.freeze([
  'buildTemporalContext',
  'deriveTemporalContext',
  'getTemporalContext',
  'createTemporalContext'
]);

function normalizeFile(file) {
  return path.normalize(file);
}

function relative(file) {
  return path.relative(root, file) || '.';
}

function isCurrentValidator(file) {
  return normalizeFile(file) === currentFileNormalized;
}

function isProductionFile(file) {
  const rel = relative(file);
  return PRODUCTION_DIRECTORIES.some((directory) => (
    rel === directory || rel.startsWith(`${directory}${path.sep}`)
  ));
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  if (!await pathExists(dir)) return [];

  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      out.push(...await walk(full));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }

  return out;
}

function exportedNames(source) {
  const names = new Set();

  const direct =
    /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g;

  for (const match of source.matchAll(direct)) {
    names.add(match[1]);
  }

  const blocks = /export\s*\{([^}]+)\}/gs;

  for (const match of source.matchAll(blocks)) {
    for (const raw of match[1].split(',')) {
      const item = raw.trim();
      if (!item) continue;

      const parts = item.split(/\s+as\s+/i);
      names.add(parts.at(-1).trim());
    }
  }

  if (/export\s+default\b/.test(source)) {
    names.add('default');
  }

  return names;
}

function importedNamedBindings(source) {
  const imports = [];
  const importPattern = /import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/gs;

  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2];
    const names = [];

    for (const raw of match[1].split(',')) {
      const cleaned = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/g, '')
        .trim();

      if (!cleaned) continue;

      const importedName = cleaned
        .split(/\s+as\s+/i)[0]
        .trim();

      if (importedName) names.push(importedName);
    }

    imports.push({ specifier, names });
  }

  return imports;
}

async function resolveLocalModule(importerFile, specifier) {
  const unresolved = path.resolve(path.dirname(importerFile), specifier);
  const candidates = [];

  if (path.extname(unresolved)) {
    candidates.push(unresolved);
  } else {
    candidates.push(`${unresolved}.js`);
    candidates.push(path.join(unresolved, 'index.js'));
  }

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return normalizeFile(candidate);
    }
  }

  return normalizeFile(candidates[0]);
}

function includesAll(source, tokens) {
  return tokens.every((token) => source.includes(token));
}

function addMissingTokenErrors(errors, source, tokens, context) {
  for (const token of tokens) {
    if (!source.includes(token)) {
      errors.push({
        type: 'MISSING_REQUIRED_TOKEN',
        context,
        token
      });
    }
  }
}

function regexWithin(source, firstPattern, secondPattern, maxDistance = 240) {
  const firstMatches = [...source.matchAll(firstPattern)];

  for (const first of firstMatches) {
    const start = first.index ?? 0;
    const segment = source.slice(start, start + maxDistance);
    if (secondPattern.test(segment)) return true;
  }

  return false;
}

function hasHourWindow(source, startHour, endHour) {
  const start = new RegExp(
    `(?:hour|hourUtc|utcHour)\\s*>=\\s*${startHour}`,
    'i'
  );
  const end = new RegExp(
    `(?:hour|hourUtc|utcHour)\\s*<\\s*${endHour}`,
    'i'
  );

  return regexWithin(source, start, end, 320) ||
    regexWithin(source, end, start, 320);
}

function hasWeekendUtcLogic(source) {
  const usesUtcDay = /getUTCDay\s*\(/.test(source);
  const commonDirect =
    /(?:day|dayUtc|utcDay)\s*===\s*0[\s\S]{0,160}(?:day|dayUtc|utcDay)\s*===\s*6/.test(source) ||
    /(?:day|dayUtc|utcDay)\s*===\s*6[\s\S]{0,160}(?:day|dayUtc|utcDay)\s*===\s*0/.test(source);
  const commonArray =
    /\[\s*0\s*,\s*6\s*\]\.includes\s*\(/.test(source) ||
    /\[\s*6\s*,\s*0\s*\]\.includes\s*\(/.test(source);

  return usesUtcDay && (commonDirect || commonArray);
}

function sourceForFiles(fileNames, sourceByFile) {
  const parts = [];
  const existing = [];

  for (const fileName of fileNames) {
    const full = normalizeFile(path.join(root, fileName));
    const source = sourceByFile.get(full);
    if (source === undefined) continue;

    existing.push(fileName);
    parts.push(`\n// ===== ${fileName} =====\n${source}`);
  }

  return {
    source: parts.join('\n'),
    existing
  };
}

function forbiddenProductionPatterns() {
  return [
    {
      code: 'SHORT_TARGET_TRADE_SIDE',
      regex: /const\s+TARGET_TRADE_SIDE\s*=\s*['"]SHORT['"]/g
    },
    {
      code: 'SHORT_TARGET_DASHBOARD_SIDE',
      regex: /const\s+TARGET_DASHBOARD_SIDE\s*=\s*['"]bear['"]/gi
    },
    {
      code: 'SHORT_TARGET_SCANNER_SIDE',
      regex: /const\s+TARGET_SCANNER_SIDE\s*=\s*['"]bear['"]/gi
    },
    {
      code: 'SHORT_NAMESPACE_DECLARATION',
      regex: /const\s+SHORT_NAMESPACE\s*=\s*['"]SHORT['"]/g
    },
    {
      code: 'SHORT_KEY_PREFIX_DECLARATION',
      regex: /const\s+SHORT_KEY_PREFIX\b/g
    },
    {
      code: 'SHORT_KEYS_DECLARATION',
      regex: /\bconst\s+SHORT_KEYS\b/g
    },
    {
      code: 'SHORT_PERSISTENT_LEARNING_KEY',
      regex: /PERSISTENT_LEARNING_KEY\s*=\s*['"]SHORT_LIVE['"]/g
    },
    {
      code: 'SHORT_CONFIG_ROOT_READ',
      regex: /\bCONFIG\.short(?:\?|\.)/g
    },
    {
      code: 'SHORT_KEYS_ROOT_READ',
      regex: /\bKEYS\.short(?:\?|\.)/g
    },
    {
      code: 'SHORT_NAMESPACED_KEY_HELPER',
      regex: /\bnamespacedShort(?:Key|Pattern)\b/g
    },
    {
      code: 'SHORT_LOCK_NORMALIZER',
      regex: /\bnormalizeShortLockKey\b/g
    },
    {
      code: 'DOUBLE_LONG_SHORT_PREFIX',
      regex: /LONG:SHORT:/g
    },
    {
      code: 'SHORT_MEASUREMENT_VERSION_ACTIVE',
      regex: /SHORT_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2/g
    },
    {
      code: 'SHORT_EXIT_FILL_VERSION_ACTIVE',
      regex: /SHORT_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1/g
    },
    {
      code: 'SHORT_EMPIRICAL_VETO_VERSION_ACTIVE',
      regex: /SHORT_EXACT_75_CHILD_NET_EDGE_VETO_V1/g
    }
  ];
}

function forbiddenLongRiskPatterns() {
  return [
    {
      code: 'SHORT_RISK_GEOMETRY',
      regex: /(?:SHORT:\s*)?tp\s*<\s*entry\s*<\s*(?:initialSl|sl)/gi
    },
    {
      code: 'SHORT_TP_RULE',
      regex: /price\s*<=\s*tp/gi
    },
    {
      code: 'SHORT_SL_RULE',
      regex: /price\s*>=\s*(?:initialSl|sl)/gi
    },
    {
      code: 'SHORT_GROSS_R_FORMULA',
      regex: /\(\s*entry\s*-\s*exitPrice\s*\)\s*\/\s*\(\s*(?:initialSl|sl)\s*-\s*entry\s*\)/gi
    },
    {
      code: 'SHORT_CURRENT_R_FORMULA',
      regex: /\(\s*entry\s*-\s*currentPrice\s*\)\s*\/\s*\(\s*(?:initialSl|sl)\s*-\s*entry\s*\)/gi
    },
    {
      code: 'SHORT_CURRENT_FIT_POLARITY',
      regex: /BEARISH_POSITIVE_BULLISH_NEGATIVE/g
    },
    {
      code: 'SHORT_CURRENT_FIT_DEFINITION',
      regex: /SHORT_MIRRORED_CURRENT_FIT/g
    }
  ];
}

function findMatches(regex, source) {
  const matches = [];
  regex.lastIndex = 0;

  for (const match of source.matchAll(regex)) {
    matches.push({
      index: match.index ?? null,
      value: match[0]
    });
  }

  regex.lastIndex = 0;
  return matches;
}

function checkLongDirectionContracts(files, sourceByFile, errors) {
  const forbidden = forbiddenProductionPatterns();
  const forbiddenRisk = forbiddenLongRiskPatterns();

  for (const file of files) {
    if (!isProductionFile(file) || isCurrentValidator(file)) continue;

    const source = sourceByFile.get(normalizeFile(file)) || '';
    const rel = relative(file);

    for (const rule of forbidden) {
      const matches = findMatches(rule.regex, source);
      for (const match of matches) {
        errors.push({
          type: 'LONG_ROOT_FORBIDDEN_SHORT_CONTRACT',
          code: rule.code,
          file: rel,
          index: match.index,
          match: match.value
        });
      }
    }

    const appearsDirectional =
      source.includes('TARGET_TRADE_SIDE') ||
      source.includes('TARGET_DASHBOARD_SIDE') ||
      source.includes('TARGET_SCANNER_SIDE');

    if (appearsDirectional) {
      const expectedDeclarations = [
        `const TARGET_TRADE_SIDE = '${TARGET_TRADE_SIDE}'`,
        `const TARGET_DASHBOARD_SIDE = '${TARGET_DASHBOARD_SIDE}'`,
        `const TARGET_SCANNER_SIDE = '${TARGET_SCANNER_SIDE}'`,
        `const OPPOSITE_TRADE_SIDE = '${OPPOSITE_TRADE_SIDE}'`
      ];

      for (const declaration of expectedDeclarations) {
        if (!source.includes(declaration)) {
          errors.push({
            type: 'LONG_DIRECTION_DECLARATION_MISSING',
            file: rel,
            declaration
          });
        }
      }
    }

    const appearsNamespaced =
      source.includes('NAMESPACE') ||
      source.includes('KEY_PREFIX') ||
      source.includes('PERSISTENT_LEARNING_KEY');

    if (appearsNamespaced) {
      const expectedNamespaceTokens = [
        `const LONG_NAMESPACE = '${LONG_NAMESPACE}'`,
        'const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`',
        `const PERSISTENT_LEARNING_KEY = '${PERSISTENT_LEARNING_KEY}'`
      ];

      for (const token of expectedNamespaceTokens) {
        if (!source.includes(token)) {
          errors.push({
            type: 'LONG_NAMESPACE_DECLARATION_MISSING',
            file: rel,
            token
          });
        }
      }
    }

    const appearsToDeclareRiskContract = [
      'riskGeometryRule',
      'tpHitRule',
      'slHitRule',
      'grossRFormula',
      'currentRFormula',
      'riskDistance'
    ].some((token) => source.includes(token));

    if (appearsToDeclareRiskContract) {
      for (const rule of forbiddenRisk) {
        const matches = findMatches(rule.regex, source);
        for (const match of matches) {
          errors.push({
            type: 'LONG_RISK_CONTRACT_NOT_MIRRORED',
            code: rule.code,
            file: rel,
            index: match.index,
            match: match.value
          });
        }
      }
    }
  }
}

function checkTaxonomyContracts(productionSource, errors) {
  const forbiddenPropertyPatterns = [
    /(?:parentFamilyFormat|parentFormat|exampleParent|exampleParentTrueMicroFamilyId)\s*:\s*['"]MICRO_SHORT_/g,
    /(?:selectableChildFamilyFormat|selectableChildFormat|exampleSelectableChild|exampleSelectableTrueMicroFamilyId)\s*:\s*['"]MICRO_SHORT_/g
  ];

  for (const regex of forbiddenPropertyPatterns) {
    const matches = findMatches(regex, productionSource);
    for (const match of matches) {
      errors.push({
        type: 'SHORT_TAXONOMY_FORMAT_IN_LONG_ROOT',
        index: match.index,
        match: match.value
      });
    }
  }

  const requiredTaxonomyTokens = [
    'MICRO_LONG_',
    'FIXED_TAXONOMY_15',
    'FIXED_TAXONOMY_75',
    'EXACT_75_CHILD',
    'EXACT_75_CHILD_TRUE_MICRO_FAMILY_ID'
  ];

  addMissingTokenErrors(
    errors,
    productionSource,
    requiredTaxonomyTokens,
    'LONG_TAXONOMY'
  );
}

function checkMeasurementAndMaturityContracts(productionSource, errors) {
  const requiredTokens = [
    MEASUREMENT_FIX_VERSION,
    EXIT_FILL_MODEL_VERSION,
    EMPIRICAL_VETO_POLICY_VERSION,
    'STRICT_EXACT_VERSION',
    'OBSERVING',
    'EARLY_OUTCOMES',
    'ACTIVE_LEARNING',
    'PASSED',
    'EMPIRICAL_VETO'
  ];

  addMissingTokenErrors(
    errors,
    productionSource,
    requiredTokens,
    'MEASUREMENT_AND_MATURITY'
  );

  const has35Threshold =
    /EMPIRICAL_VETO_MIN_COMPLETED\s*=\s*35/.test(productionSource) ||
    /completed\s*>=\s*35/.test(productionSource);

  if (!has35Threshold) {
    errors.push({
      type: 'MISSING_EMPIRICAL_VETO_THRESHOLD',
      expected: 'completed >= 35'
    });
  }

  const hasPositivePassedRule =
    /avgR\s*>\s*0/.test(productionSource) ||
    /avgR\s*>\s*EMPIRICAL_VETO_MAX_AVG_R/.test(productionSource);

  if (!hasPositivePassedRule) {
    errors.push({
      type: 'MISSING_PASSED_AVG_R_RULE',
      expected: 'completed >= 35 && avgR > 0'
    });
  }

  const hasVetoRule =
    /avgR\s*<=\s*0/.test(productionSource) ||
    /avgR\s*<=\s*EMPIRICAL_VETO_MAX_AVG_R/.test(productionSource);

  if (!hasVetoRule) {
    errors.push({
      type: 'MISSING_EMPIRICAL_VETO_AVG_R_RULE',
      expected: 'completed >= 35 && avgR <= 0'
    });
  }
}

function checkTemporalContracts(sourceByFile, productionSource, errors) {
  const projectWideRequired = [
    TEMPORAL_CONTEXT_VERSION,
    WEEKEND_POLICY_VERSION,
    SESSION_POLICY_VERSION,
    `WEEKEND_MODE = '${WEEKEND_MODE}'`,
    `SESSION_MODE = '${SESSION_MODE}'`,
    ...REQUIRED_SESSION_BUCKETS,
    ...REQUIRED_DAY_TYPES,
    ...REQUIRED_DAY_NAMES
  ];

  addMissingTokenErrors(
    errors,
    productionSource,
    projectWideRequired,
    'TEMPORAL_CONTEXT_PROJECT_WIDE'
  );

  const scannerGroup = sourceForFiles([
    'api/scanner/run.js',
    'src/market/scanner.js'
  ], sourceByFile);

  if (scannerGroup.existing.length === 0) {
    errors.push({
      type: 'TEMPORAL_SCANNER_FILES_MISSING',
      expectedAnyOf: [
        'api/scanner/run.js',
        'src/market/scanner.js'
      ]
    });
  } else {
    addMissingTokenErrors(
      errors,
      scannerGroup.source,
      [
        'temporalContextVersion',
        'contextTs',
        'hourUtc',
        'dayOfWeekUtc',
        'dayType',
        'isWeekend',
        'sessionTags',
        'primarySessionBucket',
        'sessionOverlap',
        'offHours'
      ],
      `SCANNER_TEMPORAL_CAPTURE:${scannerGroup.existing.join(',')}`
    );

    if (!/getUTCHours\s*\(/.test(scannerGroup.source)) {
      errors.push({
        type: 'SCANNER_NOT_USING_UTC_HOURS',
        files: scannerGroup.existing
      });
    }

    if (!hasWeekendUtcLogic(scannerGroup.source)) {
      errors.push({
        type: 'SCANNER_WEEKEND_UTC_LOGIC_MISSING',
        files: scannerGroup.existing,
        expected: 'getUTCDay() with Saturday=6 and Sunday=0'
      });
    }

    const requiredWindows = [
      { bucket: 'ASIA', start: 0, end: 8 },
      { bucket: 'EUROPE', start: 7, end: 16 },
      { bucket: 'US', start: 13, end: 22 }
    ];

    for (const window of requiredWindows) {
      if (!hasHourWindow(scannerGroup.source, window.start, window.end)) {
        errors.push({
          type: 'SESSION_WINDOW_MISSING_OR_DIFFERENT',
          bucket: window.bucket,
          expected: `${window.start}:00 <= UTC hour < ${window.end}:00`,
          files: scannerGroup.existing
        });
      }
    }
  }

  const tradeGroup = sourceForFiles([
    'api/trade/run.js',
    'src/trade/tradeSystem.js',
    'src/trade/positionEngine.js'
  ], sourceByFile);

  if (tradeGroup.existing.length === 0) {
    errors.push({
      type: 'TRADE_TEMPORAL_FILES_MISSING',
      expectedAnyOf: [
        'api/trade/run.js',
        'src/trade/tradeSystem.js',
        'src/trade/positionEngine.js'
      ]
    });
  } else {
    addMissingTokenErrors(
      errors,
      tradeGroup.source,
      REQUIRED_ENTRY_CONTEXT_FIELDS,
      `TRADE_ENTRY_CONTEXT:${tradeGroup.existing.join(',')}`
    );

    addMissingTokenErrors(
      errors,
      tradeGroup.source,
      REQUIRED_EXIT_CONTEXT_FIELDS,
      `TRADE_EXIT_CONTEXT:${tradeGroup.existing.join(',')}`
    );
  }

  const analyzeGroup = sourceForFiles([
    'src/analyze/analyzeEngine.js',
    'src/analyze/microFamilies.js',
    'src/analyze/rotationEngine.js'
  ], sourceByFile);

  if (analyzeGroup.existing.length === 0) {
    errors.push({
      type: 'ANALYZE_TEMPORAL_FILES_MISSING',
      expectedAnyOf: [
        'src/analyze/analyzeEngine.js',
        'src/analyze/microFamilies.js',
        'src/analyze/rotationEngine.js'
      ]
    });
  } else {
    addMissingTokenErrors(
      errors,
      analyzeGroup.source,
      REQUIRED_CONTEXT_STAT_BUCKETS,
      `ANALYZE_CONTEXT_STATS:${analyzeGroup.existing.join(',')}`
    );

    addMissingTokenErrors(
      errors,
      analyzeGroup.source,
      [
        'primarySessionBucket',
        'dayType',
        MEASUREMENT_FIX_VERSION
      ],
      `ANALYZE_CONTEXT_AGGREGATION:${analyzeGroup.existing.join(',')}`
    );
  }

  const discordGroup = sourceForFiles([
    'src/discord/discord.js',
    'src/discord/router.js',
    'src/discord/discordRouter.js'
  ], sourceByFile);

  if (discordGroup.existing.length === 0) {
    errors.push({
      type: 'DISCORD_RUNTIME_FILES_MISSING',
      expectedAnyOf: [
        'src/discord/discord.js',
        'src/discord/router.js',
        'src/discord/discordRouter.js'
      ]
    });
  } else {
    addMissingTokenErrors(
      errors,
      discordGroup.source,
      [
        'weekendDiscordEntryAllowed',
        'sessionDiscordEntryAllowed',
        'PASSED',
        WEEKEND_POLICY_VERSION,
        SESSION_POLICY_VERSION
      ],
      `DISCORD_TEMPORAL_GATE:${discordGroup.existing.join(',')}`
    );

    const hasWeekendEntryBlock =
      /weekendDiscordEntryAllowed\s*[:=]\s*false/.test(discordGroup.source) ||
      /!\s*(?:entryIsWeekend|isWeekend)/.test(discordGroup.source) ||
      /(?:entryIsWeekend|isWeekend)[\s\S]{0,180}(?:BLOCK|blocked|return\s+false)/i.test(discordGroup.source);

    if (!hasWeekendEntryBlock) {
      errors.push({
        type: 'DISCORD_WEEKEND_ENTRY_BLOCK_NOT_FOUND',
        files: discordGroup.existing
      });
    }

    const hasSessionObserveAllow =
      /sessionDiscordEntryAllowed\s*[:=]\s*true/.test(discordGroup.source) ||
      /SESSION_MODE[\s\S]{0,180}OBSERVE[\s\S]{0,180}(?:true|ALLOW)/i.test(discordGroup.source);

    if (!hasSessionObserveAllow) {
      errors.push({
        type: 'DISCORD_SESSION_OBSERVE_ALLOW_NOT_FOUND',
        files: discordGroup.existing
      });
    }
  }
}

function checkLongRiskPresence(productionSource, errors) {
  const longRiskAlternatives = [
    {
      name: 'LONG_GEOMETRY',
      patterns: [
        /initialSl\s*<\s*entry\s*<\s*tp/,
        /sl\s*<\s*entry\s*<\s*tp/
      ]
    },
    {
      name: 'LONG_TP_RULE',
      patterns: [
        /price\s*>=\s*tp/,
        /high\s*>=\s*tp/
      ]
    },
    {
      name: 'LONG_SL_RULE',
      patterns: [
        /price\s*<=\s*initialSl/,
        /price\s*<=\s*sl/,
        /low\s*<=\s*initialSl/,
        /low\s*<=\s*sl/
      ]
    },
    {
      name: 'LONG_GROSS_R',
      patterns: [
        /\(\s*exitPrice\s*-\s*entry\s*\)\s*\/\s*\(\s*entry\s*-\s*(?:initialSl|sl)\s*\)/
      ]
    },
    {
      name: 'LONG_CURRENT_R',
      patterns: [
        /\(\s*currentPrice\s*-\s*entry\s*\)\s*\/\s*\(\s*entry\s*-\s*(?:initialSl|sl)\s*\)/
      ]
    }
  ];

  for (const contract of longRiskAlternatives) {
    const present = contract.patterns.some((pattern) => pattern.test(productionSource));
    if (!present) {
      errors.push({
        type: 'LONG_RISK_CONTRACT_MISSING',
        contract: contract.name
      });
    }
  }
}

async function findTemporalBuilder(files, sourceByFile, exportsByFile) {
  for (const file of files) {
    if (!isProductionFile(file)) continue;

    const normalized = normalizeFile(file);
    const available = exportsByFile.get(normalized) || new Set();

    for (const name of TEMPORAL_EXPORT_CANDIDATES) {
      if (!available.has(name)) continue;

      const source = sourceByFile.get(normalized) || '';
      if (!source.includes('getUTCHours') || !source.includes('getUTCDay')) continue;

      return {
        file: normalized,
        name
      };
    }
  }

  return null;
}

function assertTemporalCase(errors, builderInfo, label, output, expected) {
  if (!output || typeof output !== 'object') {
    errors.push({
      type: 'TEMPORAL_RUNTIME_INVALID_OUTPUT',
      builder: builderInfo.name,
      file: relative(builderInfo.file),
      label,
      outputType: typeof output
    });
    return;
  }

  for (const [key, value] of Object.entries(expected)) {
    if (output[key] !== value) {
      errors.push({
        type: 'TEMPORAL_RUNTIME_ASSERTION',
        builder: builderInfo.name,
        file: relative(builderInfo.file),
        label,
        key,
        expected: value,
        actual: output[key]
      });
    }
  }
}

async function runOptionalTemporalRuntimeTests(
  files,
  sourceByFile,
  exportsByFile,
  errors,
  warnings
) {
  const builderInfo = await findTemporalBuilder(
    files,
    sourceByFile,
    exportsByFile
  );

  if (!builderInfo) {
    warnings.push({
      type: 'TEMPORAL_RUNTIME_TEST_SKIPPED',
      reason: 'No exported UTC temporal builder found',
      expectedAnyExport: TEMPORAL_EXPORT_CANDIDATES
    });
    return;
  }

  let module;
  try {
    module = await import(pathToFileURL(builderInfo.file).href);
  } catch (error) {
    warnings.push({
      type: 'TEMPORAL_RUNTIME_IMPORT_SKIPPED',
      file: relative(builderInfo.file),
      builder: builderInfo.name,
      error: error instanceof Error ? error.message : String(error)
    });
    return;
  }

  const builder = module[builderInfo.name];
  if (typeof builder !== 'function') {
    errors.push({
      type: 'TEMPORAL_RUNTIME_EXPORT_NOT_FUNCTION',
      file: relative(builderInfo.file),
      builder: builderInfo.name
    });
    return;
  }

  const cases = [
    {
      label: 'SATURDAY_06_ASIA',
      timestamp: Date.UTC(2026, 6, 25, 6, 0, 0),
      expected: {
        dayType: 'WEEKEND',
        isWeekend: true,
        primarySessionBucket: 'ASIA'
      }
    },
    {
      label: 'SUNDAY_22_OFF_HOURS',
      timestamp: Date.UTC(2026, 6, 26, 22, 0, 0),
      expected: {
        dayType: 'WEEKEND',
        isWeekend: true,
        primarySessionBucket: 'OFF_HOURS'
      }
    },
    {
      label: 'MONDAY_07_ASIA_EU_OVERLAP',
      timestamp: Date.UTC(2026, 6, 27, 7, 0, 0),
      expected: {
        dayType: 'WEEKDAY',
        isWeekend: false,
        primarySessionBucket: 'ASIA_EU_OVERLAP'
      }
    },
    {
      label: 'MONDAY_08_EUROPE',
      timestamp: Date.UTC(2026, 6, 27, 8, 0, 0),
      expected: {
        dayType: 'WEEKDAY',
        isWeekend: false,
        primarySessionBucket: 'EUROPE'
      }
    },
    {
      label: 'MONDAY_13_EU_US_OVERLAP',
      timestamp: Date.UTC(2026, 6, 27, 13, 0, 0),
      expected: {
        dayType: 'WEEKDAY',
        isWeekend: false,
        primarySessionBucket: 'EU_US_OVERLAP'
      }
    },
    {
      label: 'MONDAY_16_US',
      timestamp: Date.UTC(2026, 6, 27, 16, 0, 0),
      expected: {
        dayType: 'WEEKDAY',
        isWeekend: false,
        primarySessionBucket: 'US'
      }
    }
  ];

  for (const testCase of cases) {
    let output;

    try {
      output = await builder(testCase.timestamp);
    } catch (firstError) {
      try {
        output = await builder(new Date(testCase.timestamp));
      } catch (secondError) {
        errors.push({
          type: 'TEMPORAL_RUNTIME_EXECUTION_FAILED',
          file: relative(builderInfo.file),
          builder: builderInfo.name,
          label: testCase.label,
          numberArgumentError:
            firstError instanceof Error ? firstError.message : String(firstError),
          dateArgumentError:
            secondError instanceof Error ? secondError.message : String(secondError)
        });
        continue;
      }
    }

    assertTemporalCase(
      errors,
      builderInfo,
      testCase.label,
      output,
      testCase.expected
    );
  }
}

async function main() {
  const discovered = [];

  for (const directory of SOURCE_DIRECTORIES) {
    discovered.push(...await walk(path.join(root, directory)));
  }

  const files = [...new Set(discovered.map(normalizeFile))]
    .sort((a, b) => a.localeCompare(b));

  const sourceByFile = new Map();
  const exportsByFile = new Map();

  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    sourceByFile.set(normalizeFile(file), source);
    exportsByFile.set(normalizeFile(file), exportedNames(source));
  }

  const errors = [];
  const warnings = [];
  let localImportContractCount = 0;

  for (const file of files) {
    const checked = spawnSync(
      process.execPath,
      ['--check', file],
      {
        encoding: 'utf8',
        cwd: root
      }
    );

    if (checked.status !== 0) {
      errors.push({
        type: 'SYNTAX',
        file: relative(file),
        error: (checked.stderr || checked.stdout || '').trim()
      });
    }

    const source = sourceByFile.get(normalizeFile(file)) || '';
    const imports = importedNamedBindings(source);

    for (const imported of imports) {
      if (!imported.specifier.startsWith('.')) continue;

      const target = await resolveLocalModule(file, imported.specifier);

      if (!exportsByFile.has(target)) {
        errors.push({
          type: 'MISSING_LOCAL_MODULE',
          file: relative(file),
          target: relative(target),
          specifier: imported.specifier
        });
        continue;
      }

      const available = exportsByFile.get(target) || new Set();

      for (const name of imported.names) {
        localImportContractCount += 1;

        if (!available.has(name)) {
          errors.push({
            type: 'MISSING_EXPORT',
            file: relative(file),
            target: relative(target),
            name
          });
        }
      }
    }
  }

  const analyzeFile = normalizeFile(
    path.join(root, 'src/analyze/analyzeEngine.js')
  );
  const analyzeExports = exportsByFile.get(analyzeFile) || new Set();

  for (const name of REQUIRED_ANALYZE_EXPORTS) {
    if (!analyzeExports.has(name)) {
      errors.push({
        type: 'ANALYZE_CONTRACT',
        file: 'src/analyze/analyzeEngine.js',
        name
      });
    }
  }

  const productionFiles = files.filter((file) => (
    isProductionFile(file) && !isCurrentValidator(file)
  ));

  const productionSource = productionFiles
    .map((file) => (
      `\n// ===== ${relative(file)} =====\n` +
      (sourceByFile.get(normalizeFile(file)) || '')
    ))
    .join('\n');

  checkLongDirectionContracts(files, sourceByFile, errors);
  checkTaxonomyContracts(productionSource, errors);
  checkMeasurementAndMaturityContracts(productionSource, errors);
  checkTemporalContracts(sourceByFile, productionSource, errors);
  checkLongRiskPresence(productionSource, errors);

  await runOptionalTemporalRuntimeTests(
    files,
    sourceByFile,
    exportsByFile,
    errors,
    warnings
  );

  const resultBase = {
    checkedFiles: files.length,
    productionFiles: productionFiles.length,
    localImportContractsChecked: localImportContractCount,
    targetTradeSide: TARGET_TRADE_SIDE,
    dashboardSide: TARGET_DASHBOARD_SIDE,
    scannerSide: TARGET_SCANNER_SIDE,
    oppositeTradeSide: OPPOSITE_TRADE_SIDE,
    redisNamespace: LONG_NAMESPACE,
    redisKeyPrefix: LONG_KEY_PREFIX,
    persistentLearningKey: PERSISTENT_LEARNING_KEY,
    measurementFixVersion: MEASUREMENT_FIX_VERSION,
    exitFillModelVersion: EXIT_FILL_MODEL_VERSION,
    empiricalVetoPolicyVersion: EMPIRICAL_VETO_POLICY_VERSION,
    temporalContextVersion: TEMPORAL_CONTEXT_VERSION,
    weekendPolicyVersion: WEEKEND_POLICY_VERSION,
    sessionPolicyVersion: SESSION_POLICY_VERSION,
    weekendMode: WEEKEND_MODE,
    sessionMode: SESSION_MODE,
    warnings
  };

  if (errors.length > 0) {
    console.error(JSON.stringify({
      ok: false,
      ...resultBase,
      errorCount: errors.length,
      errors
    }, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify({
    ok: true,
    ...resultBase,
    syntax: 'PASS',
    localImportContracts: 'PASS',
    analyzeContract: 'PASS',
    longDirectionContracts: 'PASS',
    longRedisIsolation: 'PASS',
    longTaxonomy: 'PASS',
    longRiskGeometry: 'PASS',
    measurementGate: 'PASS',
    empiricalVeto: 'PASS',
    temporalContext: 'PASS',
    weekendPolicy: 'PASS',
    sessionPolicy: 'PASS'
  }, null, 2));
}

await main();
