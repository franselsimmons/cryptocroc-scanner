// /api/scan.js
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// --------------------
// Helpers
// --------------------
async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const t = await r.text();
  let j = null;
  try {
    j = JSON.parse(t);
  } catch {}
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${t.slice(0, 160)}`);
  return j;
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function safeObj(x) {
  return x && typeof x === "object" ? x : null;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function fmtPct(x, d = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toFixed(d)}%`;
}

function fmtNum(x, d = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(d);
}

function fmtUsd(x, d = 6) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "—";
  return `$${v.toFixed(d)}`;
}

// ✅ OB max age (stale gate)
const OB_MAX_AGE_MS = 75 * 60 * 1000; // 75 min

// ✅ Discord anti-spam
const NOTIFY_COOLDOWN_MS = 25 * 60 * 1000; // 25 min per coin
const HOLD_AFTER_ENTRY_SCANS = 2; // 2x achter elkaar ENTRY => HOLD melding

// --------------------
// Discord helpers
// --------------------
async function sendDiscord(webhook, content) {
  const url = String(webhook || "").trim();
  if (!url) return { ok: false, skipped: true };

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });

    const txt = await r.text().catch(() => "");
    if (!r.ok) {
      return { ok: false, status: r.status, preview: txt.slice(0, 200) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function stageWebhook(stageUpper) {
  // ENTRY/HOLD/SELL -> ELITE kanaal
  if (stageUpper === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE;
  if (stageUpper === "HOLD") return process.env.DISCORD_WEBHOOK_ELITE;
  if (stageUpper === "SELL") return process.env.DISCORD_WEBHOOK_ELITE;

  if (stageUpper === "ALMOST") return process.env.DISCORD_WEBHOOK_ALMOST;
  if (stageUpper === "BUILDUP") return process.env.DISCORD_WEBHOOK_BUILDUP;
  if (stageUpper === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;

  return "";
}

function pushNotice(noticesByHook, webhook, line) {
  const url = String(webhook || "").trim();
  if (!url) return;
  if (!noticesByHook[url]) noticesByHook[url] = [];
  noticesByHook[url].push(line);
}

async function flushNotices(noticesByHook) {
  const urls = Object.keys(noticesByHook || {});
  if (!urls.length) return { sent: 0, failed: 0, details: [] };

  let sent = 0;
  let failed = 0;
  const details = [];

  for (const url of urls) {
    const lines = noticesByHook[url] || [];
    if (!lines.length) continue;

    const CHUNK = 15;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const part = lines.slice(i, i + CHUNK);
      const msg = part.join("\n");

      const r = await sendDiscord(url, msg);
      if (r.ok) sent++;
      else {
        failed++;
        details.push({ webhook: url, ...r });
      }
    }
  }

  return { sent, failed, details };
}

// --------------------
// 1) BTC fetch (data)
// --------------------
async function fetchBtc() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1" +
    "&sparkline=false&price_change_percentage=1h,24h";

  const arr = await fetchJson(url);
  const b = arr?.[0] || {};

  const chg1h = n(
    b?.price_change_percentage_1h_in_currency ??
      b?.price_change_percentage_1h ??
      0,
    0
  );

  const chg24 = n(
    b?.price_change_percentage_24h_in_currency ??
      b?.price_change_percentage_24h ??
      0,
    0
  );

  const high = n(b?.high_24h, 0);
  const low = n(b?.low_24h, 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  return {
    chg1h: +chg1h.toFixed(3),
    chg24: +chg24.toFixed(3),
    range24: +range24.toFixed(3),
  };
}

function normBtcState(x) {
  const s = String(x || "").toUpperCase().trim();
  if (s === "BULL" || s === "BEAR" || s === "NEUTRAL") return s;
  return "NEUTRAL";
}

// ✅ STABIEL: 24h bepaalt regime (default ±1.0%)
function computeBtcStateLocal(btcBase, SETTINGS) {
  const cfg = safeObj(SETTINGS?.btc) || {};
  const neutral24Pct = n(cfg.neutral24Pct, 1.0); // <- jouw “neutraal zone”
  const chg24 = n(btcBase?.chg24, 0);

  if (chg24 >= neutral24Pct) return "BULL";
  if (chg24 <= -neutral24Pct) return "BEAR";
  return "NEUTRAL";
}

/**
 * ✅ BTC policy:
 * - BTC NEUTRAL  -> beide modes PREP (max BUILDUP)
 * - BTC BULL     -> bull FULL, bear PREP
 * - BTC BEAR     -> bear FULL, bull PREP
 */
function computeStageCap(mode, btcState) {
  const st = normBtcState(btcState);
  const m = String(mode || "").toLowerCase();

  // default: PREP
  let capStage = "BUILDUP";
  let allowFull = false;

  if (st === "BULL" && m === "bull") allowFull = true;
  if (st === "BEAR" && m === "bear") allowFull = true;

  if (allowFull) {
    return { cap: false, capStage: "FULL", reason: `BTC ${st}: ${m} mag door naar ALMOST/ENTRY` };
  }

  if (st === "NEUTRAL") {
    return { cap: true, capStage, reason: "BTC NEUTRAL: scannen + OB door, maar max BUILDUP (prep-mode)" };
  }

  return { cap: true, capStage, reason: `BTC ${st}: ${m} blijft prep-mode (max BUILDUP)` };
}

// ✅ 1h fine-tune: alleen confidence tweak (geen block)
function btcConfidenceAdjust(mode, btcState, btcBase, SETTINGS) {
  const cfg = safeObj(SETTINGS?.btc) || {};
  const fine1hAbs = n(cfg.fine1hAbsPct, 0.25); // vanaf welke 1h verandering we hem serieus nemen
  const boost = n(cfg.confBoost, 4);          // +/- punten op confidence

  // alleen finetune als er een “richting” is
  const st = normBtcState(btcState);
  if (st === "NEUTRAL") return { adj: 0, why: "BTC NEUTRAL: no 1h fine-tune" };

  const chg1h = n(btcBase?.chg1h, 0);
  const m = String(mode || "").toLowerCase();

  const wantUp = m === "bull";
  const pos = chg1h >= fine1hAbs;
  const neg = chg1h <= -fine1hAbs;

  // “meewerken” = 1h in dezelfde richting als jouw mode
  if (wantUp && pos) return { adj: +boost, why: `BTC 1h aligns (+${boost})` };
  if (!wantUp && neg) return { adj: +boost, why: `BTC 1h aligns (+${boost})` };

  // “tegenwerken” = 1h in tegengestelde richting
  if (wantUp && neg) return { adj: -boost, why: `BTC 1h contra (-${boost})` };
  if (!wantUp && pos) return { adj: -boost, why: `BTC 1h contra (-${boost})` };

  return { adj: 0, why: "BTC 1h small/neutral" };
}

// --------------------
// 2) Universe top coins
// --------------------
async function fetchCgTop(limit) {
  const per = Math.min(250, Math.max(50, Number(limit || 250)));
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${per}&page=1&sparkline=false&price_change_percentage=1h,24h`;

  const arr = await fetchJson(url);

  return (arr || []).map((c) => {
    const price = n(c?.current_price, 0);
    const high = n(c?.high_24h, 0);
    const low = n(c?.low_24h, 0);
    const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

    const change24 = n(
      c?.price_change_percentage_24h_in_currency ??
        c?.price_change_percentage_24h ??
        0,
      0
    );

    const change1h = n(
      c?.price_change_percentage_1h_in_currency ??
        c?.price_change_percentage_1h ??
        0,
      0
    );

    return {
      id: c?.id,
      symbol: up(c?.symbol),
      name: c?.name,
      price,
      volume: n(c?.total_volume, 0),
      marketCap: n(c?.market_cap, 0),
      change24,
      change1h,
      range24,
    };
  });
}

// --------------------
// Radar gate
// --------------------
function passRadar(core, c) {
  const R = core?.SETTINGS?.radar || {};
  const vm = core.computeVm(c.volume, c.marketCap);

  if (c.marketCap < n(R.mcapMin, 0)) return { ok: false, why: "mcap too low" };
  if (c.marketCap > n(R.mcapMax, Number.MAX_SAFE_INTEGER))
    return { ok: false, why: "mcap too high" };
  if (c.volume < n(R.volMin, 0)) return { ok: false, why: "volume too low" };
  if (vm < n(R.vmMin, 0)) return { ok: false, why: "vm too low" };
  if (Math.abs(c.change24) > n(R.maxAbsChg24, 999))
    return { ok: false, why: "chg24 too high" };
  if (c.range24 > n(R.maxRange24, 999))
    return { ok: false, why: "range24 too high" };

  return { ok: true, vm };
}

// --------------------
// Stage logic (SWING)
// --------------------
function stageFromSwing(mode, c) {
  const vm = c.vm;
  const range = c.range24;
  const ch1h = c.change1h;

  const wantUp = mode === "bull";
  const inDir = wantUp ? ch1h >= 0.2 : ch1h <= -0.2;

  if (vm >= 0.24 && range <= 20 && inDir) return "ALMOST";
  if (vm >= 0.18 && range <= 28) return "BUILDUP";
  return "RADAR";
}

// --------------------
// OB map loader
// --------------------
async function loadObMap(mode) {
  const blob = await kv.get(`ob:map:${mode}`);
  const m = safeObj(blob)?.map;
  return safeObj(m) || null;
}

async function getObForSymbol({ core, mode, symbol, obMap }) {
  const sym = up(symbol);
  if (obMap && obMap[sym]) return obMap[sym];
  return await kv.get(core.keyObResult(mode, sym));
}

// --------------------
// ✅ Adaptive entry thresholds (ALTIJD uit core tiers)
// --------------------
function adaptiveEntryThresholds(core, c, vm) {
  const base = core?.SETTINGS?.entry || {};
  const mc = n(c?.marketCap, 0);

  const tiers = Array.isArray(base?.adaptiveTiers) ? base.adaptiveTiers : null;

  const oneTier = {
    maxMc: Infinity,
    minConf: n(base.minConfidence, 58),
    spreadMax: n(base.spreadMaxPct, 1.2),
    depth1pMin: n(base.depthMinUsd1p, 30_000),
    obScoreMin: n(base.obScoreMin, 0.04),
  };

  const list = tiers?.length ? tiers : [oneTier];
  const t = list.find((x) => mc <= n(x.maxMc, Infinity)) || list[list.length - 1];

  const vmBonus = vm >= 0.8 ? 4 : vm >= 0.5 ? 2 : 0;

  const baseMinConf = n(base.minConfidence, n(t.minConf, 58));
  const tierMinConf = n(t.minConf, baseMinConf);
  const minConfidence = Math.max(0, Math.max(baseMinConf, tierMinConf - vmBonus));

  const baseSpread = n(base.spreadMaxPct, n(t.spreadMax, 1.2));
  const tierSpread = n(t.spreadMax, baseSpread);
  const spreadMaxPct = Math.min(baseSpread, tierSpread);

  const baseDepth = n(base.depthMinUsd1p, n(t.depth1pMin, 30_000));
  const tierDepth = n(t.depth1pMin, baseDepth);
  const depthMinUsd1p = Math.max(baseDepth, tierDepth);

  const baseScore = n(base.obScoreMin, n(t.obScoreMin, 0.04));
  const tierScore = n(t.obScoreMin, baseScore);
  const obScoreMin = Math.max(baseScore, tierScore);

  return { minConfidence, spreadMaxPct, depthMinUsd1p, obScoreMin };
}

// --------------------
// ✅ Consistency + scans + prevStage
// + extra: entryStreak + lastNotifyAt + lastHoldAt
// --------------------
function updateStateAndConsistency(stateObj, symbol, stageFinal, core, nowTs) {
  const S = stateObj || {};
  const sym = up(symbol);
  const entryCfg = core?.SETTINGS?.entry || {};

  const need = Math.max(2, n(entryCfg.samplesNeed, 4));
  const minAgree = Math.max(1, n(entryCfg.minAgree, 3));

  const prev = safeObj(S[sym]) || {};
  const prevStage = up(prev.stage || "");

  const scans = n(prev.scans, 0) + 1;

  const histPrev = Array.isArray(prev.hist) ? prev.hist : [];
  const st = up(stageFinal);
  const hist = histPrev.concat([st]).slice(-Math.max(need, 12));

  const same = hist.filter((x) => x === st).length;
  const total = hist.length;
  const ratio = total > 0 ? same / total : 0;

  const ok = total >= need && same >= minAgree;

  const prevEntryStreak = n(prev.entryStreak, 0);
  const entryStreak = st === "ENTRY" ? prevEntryStreak + 1 : 0;

  S[sym] = {
    ...prev,
    scans,
    hist,
    lastSeenAt: nowTs,
    stage: st,
    entryStreak,
  };

  return {
    state: S,
    prevStage,
    stageScans: scans,
    entryStreak,
    consistency: { ok, ratio, same, total, need, minAgree },
  };
}

function canNotify(stateEntry, nowTs) {
  const lastAt = n(stateEntry?.lastNotifyAt, 0);
  if (lastAt > 0 && nowTs - lastAt < NOTIFY_COOLDOWN_MS) return false;
  return true;
}

function markNotified(stateObj, sym, nowTs) {
  if (!stateObj?.[sym]) return;
  stateObj[sym].lastNotifyAt = nowTs;
}

function markHoldNotified(stateObj, sym, nowTs) {
  if (!stateObj?.[sym]) return;
  stateObj[sym].lastHoldAt = nowTs;
  stateObj[sym].lastNotifyAt = nowTs;
}

function holdAlreadySentRecently(stateEntry, nowTs) {
  const lastHoldAt = n(stateEntry?.lastHoldAt, 0);
  if (lastHoldAt > 0 && nowTs - lastHoldAt < NOTIFY_COOLDOWN_MS) return true;
  return false;
}

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // "bull" or "bear"
    const core = await import(`../lib/_core_${mode}.js`);

    const now = Date.now();

    // BTC data
    const btcBase = await fetchBtc();

    // ✅ NIEUW: 24h regime = local, stabiel
    const btcState = computeBtcStateLocal(btcBase, core.SETTINGS);

    // ✅ NIEUW: 1h fine tune (confidence +/-)
    const btcTune = btcConfidenceAdjust(mode, btcState, btcBase, core.SETTINGS);

    const btc = { ...btcBase, state: btcState, tune: btcTune };

    // ✅ stage cap policy (geen hard block)
    const cap = computeStageCap(mode, btc.state);

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    const cg = await fetchCgTop(core.SETTINGS.CG_TOP);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];

    const state = (await kv.get(core.keyState(mode))) || {};
    const obMap = await loadObMap(mode);

    const noticesByHook = {};

    for (const c of cg) {
      const radarGate = passRadar(core, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;

      let stageBase = stageFromSwing(mode, { ...c, vm });

      // OB lookup blijft altijd lopen
      const ob = await getObForSymbol({ core, mode, symbol: c.symbol, obMap });

      const obTs = n(ob?.ob?.ts ?? ob?.ts, 0);
      const obAge = obTs > 0 ? now - obTs : Number.POSITIVE_INFINITY;
      const obFresh = obTs > 0 && obAge <= OB_MAX_AGE_MS;

      const obValid = !!ob?.valid && obFresh;

      const spreadPct = n(ob?.ob?.spreadPct ?? ob?.spreadPct, 999);
      const depthMinUsd1p = n(ob?.ob?.depthMinUsd1p ?? ob?.depthMinUsd1p, 0);
      const obScore = n(ob?.ob?.score ?? ob?.score, 0);

      // base confidence uit core + BTC 1h fine-tune
      const confidenceBase = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid,
      });

      const confidence = Math.max(0, Math.min(100, n(confidenceBase, 0) + n(btcTune.adj, 0)));

      const thr = adaptiveEntryThresholds(core, c, vm);

      let almostGate = "n/a";
      let entryGate = "n/a";

      let stage = stageBase;

      // ✅ cap: nooit voorbij BUILDUP in prep-mode
      if (cap.cap && (stageBase === "ALMOST" || stageBase === "ENTRY")) {
        stage = "BUILDUP";
        almostGate = `capped: ${cap.capStage}`;
        entryGate = `capped: ${cap.capStage}`;
      } else {
        let obSamples = null;

        if (stageBase === "ALMOST") {
          obSamples = await kv.get(core.keyObSamples(mode, c.symbol));

          const slopeCheck =
            typeof core.checkObSlopeGate === "function"
              ? core.checkObSlopeGate({
                  stage: "almost",
                  mode,
                  obSamples,
                  settings: core.SETTINGS,
                })
              : { ok: true };

          if (!slopeCheck.ok) {
            stageBase = "BUILDUP";
            stage = "BUILDUP";
            almostGate = slopeCheck.reason || "OB slope failed in ALMOST";
          } else {
            almostGate = "passed";
          }
        }

        if (stageBase === "ALMOST") {
          if (!ob) entryGate = "OB missing";
          else if (!obFresh) entryGate = `OB stale (${Math.round(obAge / 1000)}s)`;
          else if (!obValid) entryGate = "OB validating";
          else if (confidence < n(thr.minConfidence, 0))
            entryGate = `Confidence < ${thr.minConfidence}`;
          else if (spreadPct > n(thr.spreadMaxPct, 999))
            entryGate = `Spread > ${thr.spreadMaxPct}%`;
          else if (depthMinUsd1p < n(thr.depthMinUsd1p, 0))
            entryGate = `Depth1% < $${thr.depthMinUsd1p}`;
          else if (Math.abs(obScore) < n(thr.obScoreMin, 0))
            entryGate = `OB score < ${thr.obScoreMin}`;
          else {
            if (!obSamples) obSamples = await kv.get(core.keyObSamples(mode, c.symbol));

            const slopeCheck2 =
              typeof core.checkObSlopeGate === "function"
                ? core.checkObSlopeGate({
                    stage: "entry",
                    mode,
                    obSamples,
                    settings: core.SETTINGS,
                  })
                : { ok: true };

            const pressureDelta = n(ob?.ob?.pressureDeltaUsd ?? ob?.pressureDeltaUsd, 0);
            const score1p = n(ob?.ob?.score1p ?? ob?.score1p, 0);

            const pressureOk = mode === "bull" ? pressureDelta >= 0 : pressureDelta <= 0;
            const score1pOk = mode === "bull" ? score1p >= -0.1 : score1p <= 0.1;

            if (!slopeCheck2.ok) {
              entryGate = slopeCheck2.reason || "OB slope failed at ENTRY";
            } else if (!pressureOk) {
              entryGate = "Pressure delta contra";
            } else if (!score1pOk) {
              entryGate = "1% imbalance weird";
            } else {
              stage = "ENTRY";
              entryGate = "passed";
            }
          }
        }
      }

      const sym = up(c.symbol);
      const prevEntry = safeObj(state[sym]) || {};
      const stFix = updateStateAndConsistency(state, sym, stage, core, now);

      const stageScans = stFix.stageScans;
      const consistency = stFix.consistency;
      const prevStage = up(stFix.prevStage);
      const currStage = up(stage);
      const entryStreak = n(stFix.entryStreak, 0);

      // Discord (zelfde logica, nu met confidence na BTC-tune)
      if (prevStage) {
        const doNotify = canNotify(prevEntry, now);

        if (doNotify && prevStage === "ENTRY" && currStage !== "ENTRY") {
          const hook = stageWebhook("SELL");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `ENTRY → **SELL**  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
            `price ${fmtUsd(c.price, 6)}`;
          pushNotice(noticesByHook, hook, line);
          markNotified(state, sym, now);
        } else if (doNotify && prevStage !== "ENTRY" && currStage === "ENTRY") {
          const hook = stageWebhook("ENTRY");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `${prevStage} → **ENTRY**  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
            `price ${fmtUsd(c.price, 6)}`;
          pushNotice(noticesByHook, hook, line);
          markNotified(state, sym, now);
        } else if (
          currStage === "ENTRY" &&
          prevStage === "ENTRY" &&
          entryStreak === HOLD_AFTER_ENTRY_SCANS &&
          !holdAlreadySentRecently(prevEntry, now)
        ) {
          const hook = stageWebhook("HOLD");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `ENTRY → **HOLD**  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
            `price ${fmtUsd(c.price, 6)}`;
          pushNotice(noticesByHook, hook, line);
          markHoldNotified(state, sym, now);
        } else if (doNotify && prevStage !== currStage) {
          const hook = stageWebhook(currStage);
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `${prevStage} → **${currStage}**  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
            `price ${fmtUsd(c.price, 6)}`;
          pushNotice(noticesByHook, hook, line);
          markNotified(state, sym, now);
        }
      }

      const item = {
        id: c.id,
        symbol: sym,
        name: c.name,
        price: c.price,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: +c.change24.toFixed(4),
        change1h: +c.change1h.toFixed(4),
        range24: +c.range24.toFixed(4),
        vm: +vm.toFixed(6),

        confidenceBase,
        confidence,
        confidenceBtcAdj: btcTune.adj,

        stage: currStage,
        stageScans,
        consistency,

        req: {
          minConfidence: thr.minConfidence,
          spreadMaxPct: thr.spreadMaxPct,
          depthMinUsd1p: thr.depthMinUsd1p,
          obScoreMin: thr.obScoreMin,
        },

        ob: ob
          ? {
              valid: !!ob.valid,
              fresh: !!obFresh,
              stale: !!ob.stale,
              ageSec: obTs > 0 ? Math.round(obAge / 1000) : null,
              reason: String(ob.reason || ""),
              score: Number(obScore),
              spreadPct: Number(spreadPct),
              depthMinUsd1p: Number(depthMinUsd1p),
              lor: Number(n(ob?.ob?.lor ?? ob?.lor, 1)),
              score1p: n(ob?.ob?.score1p ?? ob?.score1p, 0),
              score05p: n(ob?.ob?.score05p ?? ob?.score05p, 0),
              pressureDeltaUsd: n(ob?.ob?.pressureDeltaUsd ?? ob?.pressureDeltaUsd, 0),
              slopeScore: n(ob?.slopeScore ?? ob?.ob?.slopeScore ?? ob?.slope ?? 0, 0),
              slopeDepth1p: n(ob?.slopeDepth1p ?? ob?.ob?.slopeDepth1p ?? 0, 0),
              ts: obTs || null,
            }
          : { status: "none" },

        why: { almostGate, entryGate },
      };

      if (currStage === "ENTRY") entry.push(item);
      else if (currStage === "ALMOST") almost.push(item);
      else if (currStage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    entry.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    almost.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    buildup.sort((a, b) => b.vm - a.vm);
    radar.sort((a, b) => b.vm - a.vm);

    const discord = await flushNotices(noticesByHook);

    const btcCfg = safeObj(core.SETTINGS?.btc) || {};
    const neutral24Pct = n(btcCfg.neutral24Pct, 1.0);
    const fine1hAbsPct = n(btcCfg.fine1hAbsPct, 0.25);
    const confBoost = n(btcCfg.confBoost, 4);

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      meta: {
        cadence: "30m",
        btcPolicy: "24h regime + 1h confidence fine-tune; NEUTRAL/opposite => cap to BUILDUP, maar scan+OB blijven lopen",
        capActive: !!cap.cap,
        capStage: cap.capStage,
        capReason: cap.reason,
        neutralZone: `BTC 24h between -${neutral24Pct}% and +${neutral24Pct}%`,
        fineTune: `BTC 1h abs >= ${fine1hAbsPct}% => confidence +/-${confBoost}`,
      },
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
      },
      funnel: { entry, almost, buildup, radar },
      obMap: obMap ? { ok: true, size: Object.keys(obMap).length } : { ok: false },
      discord: {
        enabled: true,
        sent: discord.sent,
        failed: discord.failed,
        errors: (discord.details || []).slice(0, 5),
      },
      note:
        "Update: BTC NEUTRAL stopt niet meer alles. Beide modes blijven ‘huiswerk’ doen (RADAR/BUILDUP) met OB-data. Alleen ALMOST/ENTRY is gecapt in prep-mode.",
    };

    await kv.set(core.keyLatest(mode), result);
    await kv.set(core.keyState(mode), state);

    res.statusCode = 200;
    return res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}