# Clean Micro-Rotation LONG Trading System (v2 - net-aware)

A lean three-stage crypto-futures research and signal pipeline for Bitget USDT perpetual futures, built around deterministic micro-families whose primary virtual and shadow outcomes are scored net of costs.

This repository is the separate **LONG root**. It must read, write, rotate, reset, and publish only LONG data. The existing SHORT root is a separate system and must never be accessed or mutated from this repository.

```text
Scanner      -> LONG candidates and volatile snapshots
TradeSystem  -> live validation, virtual execution, and position monitoring
Analyze      -> families, exact child-75 statistics, net scoring, and rotation
```

## Core LONG contracts

```js
const TARGET_TRADE_SIDE = 'LONG';
const TARGET_DASHBOARD_SIDE = 'bull';
const TARGET_SCANNER_SIDE = 'bull';
const OPPOSITE_TRADE_SIDE = 'SHORT';

const LONG_NAMESPACE = 'LONG';
const LONG_KEY_PREFIX = `${LONG_NAMESPACE}:`;
const PERSISTENT_LEARNING_KEY = 'LONG_LIVE';
```

Required LONG geometry:

```text
initialSl < entry < tp
riskDistance = entry - initialSl
grossR = (exitPrice - entry) / (entry - initialSl)
currentR = (currentPrice - entry) / (entry - initialSl)
```

Trigger rules:

- TP is hit when `price >= tp` or candle `high >= tp`.
- SL is hit when `price <= initialSl` or candle `low <= initialSl`.
- If TP and SL are both touched in one candle, the existing conservative same-candle rule remains authoritative.
- TP and SL use the trigger boundary as the gross exit fill.
- `TIME_STOP` uses the actually observed market price.
- Fees, spread, slippage, and impact are applied after the gross fill is determined.

Reference checks:

```text
entry = 100
initialSl = 98
tp = 104

high = 104      -> TP
low = 98        -> SL
exitPrice = 103 -> +1.5R gross
exitPrice = 98  -> -1.0R gross
```

## What changed in v2

### 1. Net-of-cost learning

`src/trade/costModel.js` converts every valid primary virtual and shadow outcome from gross R to net R using both-leg taker fees, directional spread/slippage, and a market-impact buffer.

For LONG trades:

- entry execution is modeled on the ask side;
- exit execution is modeled on the bid side;
- trigger-boundary fill is established first;
- costs are applied afterward;
- `exitR` and `pnlPct` carry net values into Analyze.

The existing Wilson lower bound, Bayesian shrinkage, balanced score, net edge, and profit-factor stack therefore learns from realizable performance instead of gross candle movement.

Current measurement and veto contracts:

```text
LONG_MEASUREMENT_FIX_TRIGGER_BOUNDARY_EXIT_FILL_V2
LONG_TRIGGER_BOUNDARY_FILL_PLUS_COST_MODEL_V1
LONG_EXACT_75_CHILD_NET_EDGE_VETO_V1
```

Outcomes from old or incompatible measurement versions must not silently enter the current V2 statistics.

### 2. Stable micro-family cardinality

Continuous confluence and sniper values are reduced to coarse `LO`, `MID`, and `HI` tiers. The three confirmation booleans are collapsed into one deterministic `entryQuality` ordinal.

The taxonomy is fixed:

1. **Parent-15** - context and aggregation only.
2. **Exact child-75** - the finest stable and manually selectable identity.
3. **Micro-micro aliases** - aliases of the same exact child-75 ID, not a deeper hash layer.

Parent format:

```text
MICRO_LONG_{SETUP}_{REGIME}
```

Exact child format:

```text
MICRO_LONG_{SETUP}_{REGIME}_{CONFIRMATION_PROFILE}
```

Rules:

- Exactly 15 LONG parent families exist.
- Exactly 75 LONG child families are selectable.
- `microMicroFamilyId` and `exactMicroMicroFamilyId` deliberately resolve to the exact child-75 ID.
- Parent, macro, scanner, symbol, raw-score, and execution fingerprints are metadata only.
- Day type, weekend state, UTC hour, and session are never added to the family ID.
- Only an exact selected `MICRO_LONG_...` child-75 ID may activate Discord entry publishing.
- Any `MICRO_SHORT_...` selection is invalid in this root.

### 3. Path-aware direct-SL measurement

`directToSL` is derived from the actual path using MFE and MAE instead of remaining dead metadata. Analyze can therefore apply the existing `directSLPct` penalty to a real observation.

The path layer also records:

- `mfeR`;
- `maeR`;
- `beWouldExit`;
- `gaveBackAfterOneR`;
- `nearTpThenLoss`;
- direct-SL state;
- near-TP state;
- break-even and giveback behavior.

All direction-sensitive calculations use LONG semantics.

### 4. Snapshot staleness guard

New entries are skipped when the scanner snapshot exceeds `TRADE_MAX_SNAPSHOT_AGE_SEC`, defaulting to 8 minutes unless configuration overrides it.

Open-position monitoring is never skipped because of snapshot age, weekend state, or session state.

### 5. Enforced sizing and correlation caps

`src/trade/positionSizing.js` scales risk per trade using family confidence, sample maturity, and balanced score.

Portfolio controls bound:

- total open risk;
- total LONG-side risk;
- counter-BTC risk;
- symbol and family concentration;
- concurrent exposure.

These caps remain enforced from the first live validation run. They are portfolio constraints, not optional optimization switches.

### 6. Breakeven and trailing are measured first

`updatePathMetrics` records what break-even and trailing logic would have done for each position. Live management must remain disabled until family-level evidence supports it.

```text
MANAGE_APPLY_LIVE=false
```

A future family-specific management policy may use `GaveBack-1R`, `BE-Exit%`, `nearTpThenLoss`, net AvgR, and sample size. It must not be enabled globally merely because one family benefits.

## Family maturity and empirical veto

The current exact child-75 maturity state is determined from valid completed outcomes:

```text
completed = 0             -> OBSERVING
completed 1 through 19    -> EARLY_OUTCOMES
completed 20 through 34   -> ACTIVE_LEARNING
completed >= 35, avgR > 0 -> PASSED
completed >= 35, avgR <= 0 -> EMPIRICAL_VETO
```

The empirical veto is recoverable. New valid outcomes may move the current-version net average above zero and return the family to `PASSED`.

`CurrentFit` is an additional live suitability filter:

- bullish context contributes positively;
- bearish context contributes negatively;
- it may block a currently unsuitable entry;
- it may never upgrade a non-PASSED family;
- it may never bypass exact child selection or the statistical family gate.

## UTC temporal context

The LONG root records weekend and session context without fragmenting the 75-family taxonomy.

Fixed versions:

```js
const TEMPORAL_CONTEXT_VERSION = 'LONG_TEMPORAL_CONTEXT_UTC_V1';
const WEEKEND_POLICY_VERSION = 'LONG_WEEKEND_OBSERVE_DISCORD_BLOCK_V1';
const SESSION_POLICY_VERSION = 'LONG_SESSION_OBSERVE_V1';

const WEEKEND_MODE = 'OBSERVE';
const SESSION_MODE = 'OBSERVE';
```

All time calculations use UTC.

### Day fields

```text
dayOfWeekUtc:
  MONDAY
  TUESDAY
  WEDNESDAY
  THURSDAY
  FRIDAY
  SATURDAY
  SUNDAY

dayType:
  WEEKDAY
  WEEKEND
```

Saturday and Sunday UTC are `WEEKEND`. Monday through Friday UTC are `WEEKDAY`.

### Fixed UTC sessions

Half-open windows are used:

```text
ASIA    00:00 <= hour < 08:00
EUROPE  07:00 <= hour < 16:00
US      13:00 <= hour < 22:00
```

Overlaps:

```text
ASIA_EU_OVERLAP  07:00 <= hour < 08:00
EU_US_OVERLAP    13:00 <= hour < 16:00
```

Primary bucket priority:

1. `EU_US_OVERLAP`
2. `ASIA_EU_OVERLAP`
3. `ASIA`
4. `EUROPE`
5. `US`
6. `OFF_HOURS`

Required context shape where relevant:

```js
{
  temporalContextVersion: 'LONG_TEMPORAL_CONTEXT_UTC_V1',
  contextTs: 0,
  hourUtc: 14,
  dayOfWeekUtc: 'TUESDAY',
  dayType: 'WEEKDAY',
  isWeekend: false,
  sessionTags: ['EUROPE', 'US'],
  primarySessionBucket: 'EU_US_OVERLAP',
  sessionOverlap: true,
  offHours: false
}
```

Boundary checks:

```text
06:00 UTC -> ASIA
07:00 UTC -> ASIA_EU_OVERLAP
08:00 UTC -> EUROPE
13:00 UTC -> EU_US_OVERLAP
16:00 UTC -> US
22:00 UTC -> OFF_HOURS
```

## Entry and exit context

Entry context is frozen when a position is created and remains unchanged for the position lifetime:

```text
entryTs
entryHourUtc
entryDayOfWeekUtc
entryDayType
entryIsWeekend
entrySessionTags
entrySessionBucket
entrySessionOverlap
entryOffHours
```

Exit context is recorded when the position closes:

```text
exitTs
exitHourUtc
exitDayOfWeekUtc
exitDayType
exitIsWeekend
exitSessionTags
exitSessionBucket
exitSessionOverlap
exitOffHours
```

Entry context controls whether a new Discord entry is eligible. Exit context is analysis metadata only.

A position opened before a weekend or session transition must continue to be monitored and closed normally.

## Weekend policy

With `WEEKEND_MODE='OBSERVE'`, weekends remain fully active for research and virtual execution while only new Discord entry publication is blocked.

```js
weekendLearningAllowed = true;
weekendVirtualEntryAllowed = true;
weekendDiscordEntryAllowed = false;
weekendExitMonitoringAllowed = true;
weekendOutcomeRecordingAllowed = true;
```

Weekend behavior:

- scanner continues;
- Analyze observations continue;
- primary virtual and shadow positions may open;
- TP, SL, and TIME_STOP continue;
- outcomes continue to be recorded;
- family statistics continue to update;
- weekend outcomes are labeled separately;
- new Discord entry alerts are blocked;
- existing position monitoring and Discord exits remain allowed.

Weekend metadata never creates new family IDs.

## Session policy

With `SESSION_MODE='OBSERVE'`, all sessions remain eligible for scanning, virtual learning, and Discord entry evaluation.

```js
sessionLearningAllowed = true;
sessionVirtualEntryAllowed = true;
sessionDiscordEntryAllowed = true;
sessionPolicyObservedOnly = true;
```

Session context is measured and displayed but does not modify the statistical family gate. It cannot convert a non-PASSED family into a PASSED family.

## Context statistics

Context statistics are nested inside the exact child-75 family aggregate. They do not split the family identity.

Minimum day-type buckets:

```js
contextStats = {
  WEEKDAY: {},
  WEEKEND: {}
};
```

Minimum primary-session buckets:

```js
sessionStats = {
  ASIA: {},
  EUROPE: {},
  US: {},
  ASIA_EU_OVERLAP: {},
  EU_US_OVERLAP: {},
  OFF_HOURS: {}
};
```

Each supported bucket may contain:

```text
seen
observations
completed
wins
losses
flats
totalR
avgR
grossWinR
grossLossR
profitFactor
directSLCount
directSLPct
totalCostR
avgCostR
```

Counting rules:

- one valid outcome counts once in total family statistics;
- once in either `WEEKDAY` or `WEEKEND`;
- once in the primary session bucket;
- overlap outcomes count in the overlap bucket, not again in both component buckets;
- `sessionTags` may still list all active sessions as informational metadata;
- only valid virtual or shadow outcomes from the current measurement version count.

## Discord runtime gate

A new LONG entry alert requires every gate below:

```text
exactSelected75ChildMatch
AND familyGate === 'PASSED'
AND currentFitEligible
AND weekendDiscordEntryAllowed
AND sessionDiscordEntryAllowed
AND !cooldownBlocked
AND !duplicateBlocked
```

Additional invariants:

- parent or macro matching cannot publish;
- scanner and execution fingerprints cannot publish;
- a SHORT child ID cannot publish;
- CurrentFit cannot replace `PASSED`;
- weekend state blocks only new entry publication;
- exit alerts and open-position monitoring remain allowed;
- session OBSERVE mode does not block entries.

## LONG Redis-root isolation

All runtime data belongs under LONG key preferences such as:

```text
KEYS.long
KEYS.scan.long...
KEYS.trade.long...
KEYS.analyze.long...
KEYS.discord.long...
KEYS.reset.long...
```

Every fallback must remain under:

```text
LONG:
```

The implementation must prevent a pre-prefixed SHORT key from being nested below LONG. This is always invalid:

```text
LONG:SHORT:...
```

The LONG root independently owns:

- scanner snapshots and latest snapshot;
- scanner run metadata;
- locks;
- open positions;
- trade run metadata;
- last processed snapshots;
- Analyze observations and outcomes;
- shadow positions;
- exact child-75 statistics;
- active and next rotation;
- Discord logs;
- cooldown and dedupe state;
- reset logs.

A LONG reset must never read, delete, rewrite, or expire SHORT-root data.

## Installation

1. Place the LONG files in the separate LONG repository root.
2. Copy `.env.example` to `.env`.
3. Fill the exact Upstash, Discord, Bitget, and runtime values defined by `.env.example`.
4. Set a strong Vercel `CRON_SECRET` and keep the API-route authorization checks enabled.
5. Run `npm install`.
6. Run `npm run validate`.
7. Deploy the production project.

Node.js is pinned by `package.json` to the supported Vercel major runtime:

```json
{
  "engines": {
    "node": "24.x"
  }
}
```

## Vercel crons

The supplied `vercel.json` uses UTC schedules:

```text
*/5 * * * *  /api/scanner/run
*/2 * * * *  /api/trade/run
0 22 * * 0   /api/analyze/weekly-freeze
0 0 * * 1    /api/analyze/activate-rotation
```

Meaning:

- scanner: every 5 minutes;
- trade system and open-position monitoring: every 2 minutes;
- freeze next rotation: Sunday 22:00 UTC;
- activate rotation: Monday 00:00 UTC.

The 2-minute and 5-minute schedules require a Vercel plan that supports per-minute cron execution. Production cron endpoints must be lock-protected and idempotent because a run may overlap or be delivered more than once.

CLI equivalents:

```bash
npm run scanner:run
npm run trade:run
npm run analyze:freeze
npm run analyze:activate
```

## Dashboard

The admin dashboard is served from:

```text
/public/admin.html
/admin
/admin/micro-families
```

The micro-family table should expose current-version LONG data including:

- maturity and family gate;
- Net AvgR and Net TotalR;
- CostR;
- profit factor;
- direct-SL percentage;
- GaveBack-1R;
- BE-Exit%;
- weekday versus weekend context;
- primary-session context;
- whether weekend and session policy are observing or enforcing.

A display route must not claim that a policy is enforced when it only renders metadata.

## Recommended go-live sequence

1. Run primary virtual and shadow learning first.
2. Reject incompatible measurement versions from current V2 statistics.
3. Require the configured minimum weighted completed sample count.
4. Require the exact selected child-75 family to be `PASSED` on net results.
5. Keep sizing and correlation caps enforced from day one.
6. Keep weekend learning active while Discord weekend entries remain blocked.
7. Keep session policy in OBSERVE until family-level evidence supports a stricter policy.
8. Enable family-specific break-even or trailing only after the measured path data supports it.

## Repository layout

```text
src/
  config.js
  keys.js
  redis.js
  lock.js
  utils.js
  market/
    bitgetClient.js
    indicators.js
    scanner.js
    fakeBreakout.js
    marketWeather.js
  trade/
    tradeSystem.js
    positionEngine.js
    riskEngine.js
    costModel.js
    positionSizing.js
  analyze/
    analyzeEngine.js
    microFamilies.js
    scoring.js
    rotationEngine.js
  discord/
    discord.js
api/
  scanner/
  trade/
  analyze/
  admin/
scripts/
  runScanner.js
  runTradeSystem.js
  freezeWeekly.js
  activateRotation.js
public/
  admin.html
```

## Execution scope

This repository does not place exchange orders by itself. `TradeSystem` maintains primary virtual and shadow positions and emits gated Discord `ENTRY` and `EXIT` actions. An external execution layer may consume those actions only after the LONG net statistics and operational controls have been accepted.

## Validation

Run before every deployment:

```bash
npm run validate
```

The package scripts perform:

- JSON parsing for `package.json` and `vercel.json`;
- `node --check` across all JavaScript under `src`, `api`, and `scripts`;
- a LONG exported key/config double-prefix isolation check;
- critical ESM import-contract checks;
- direct imports of the TradeSystem and Analyze engine.

The validation does not require Redis credentials merely to parse and import modules. Runtime integration still requires the environment variables defined by `.env.example`.
