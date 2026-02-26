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

// ======================================================
// ✅ TRADE ENGINE (ENTRY -> HOLD -> SELL)
// ======================================================
const TRADE_TTL_SEC = 60 * 60 * 48; // 48 uur
const REENTRY_COOLDOWN_SEC = 60 * 60; // 1 uur rust na SELL

const TIME_STOP_SCANS = 6; // 6 scans = 3 uur
const TIME_STOP_MAXPNL = 0.015; // 1.5%

const HOLD_AFTER_SCANS = 2; // 1x HOLD melding na 2 scans open

// ✅ SELL LOG (zodat pagina SELL kan tonen)
const SELLS_TTL_SEC = 60 * 60 * 48; // 48 uur
const SELLS_KEEP = 50;

function kTrade(mode, sym) {
  return `trade:${String(mode).toLowerCase()}:${up(sym)}`;
}
function kCooldown(mode, sym) {
  return `trade:cooldown:${String(mode).toLowerCase()}:${up(sym)}`;
}
function kSells(mode) {
  return `trade:sells:${String(mode).toLowerCase()}`;
}

async function logSell(mode, sellObj) {
  const key = kSells(mode);
  const prev = (await kv.get(key)) || [];
  const arr = Array.isArray(prev) ? prev : [];
  arr.push(sellObj);
  const last = arr.slice(-SELLS_KEEP);
  await kv.set(key, last, { ex: SELLS_TTL_SEC });
  return last;
}

function calcPnlPct(mode, entryPrice, nowPrice) {
  const e = n(entryPrice, 0);
  const p = n(nowPrice, 0);
  if (!(e > 0) || !(p > 0)) return 0;

  if (String(mode).toLowerCase() === "bear") {
    // short: winst als prijs daalt
    return (e - p) / e;
  }
  // long: winst als prijs stijgt
  return (p - e) / e;
}

// hybride stop op basis van range24 (simpel + passend bij smallcaps)
function stopPctFromRange24(range24Pct) {
  const r = n(range24Pct, 0);
  if (r <= 18) return 0.03; // 3.0%
  if (r <= 28) return 0.035; // 3.5%
  return 0.045; // 4.5%
}

// “OB tegen” = pressure + score draaien tegen jouw kant
function isObAgainst(mode, ob) {
  const pd = n(ob?.ob?.pressureDeltaUsd ?? ob?.pressureDeltaUsd, 0);
  const sc = n(ob?.ob?.score ?? ob?.score, 0);

  if (String(mode).toLowerCase() === "bear") {
    // bear wil neer: bullish pressure/score = tegen
    return pd > 0 && sc > 0;
  }
  // bull wil omhoog: bearish pressure/score = tegen
  return pd < 0 && sc < 0;
}

function isObInvalidFresh(obValid, obFresh, ob) {
  if (!obFresh) return false; // stale = geen harde conclusie
  if (!ob) return true;
  if (ob.valid === false) return true;
  if (!obValid) return true;
  return false;
}

// tradeStatus voor pagina: ENTRY (net open), HOLD (open), —
function pageTradeStatus(tradeInfo) {
  if (!tradeInfo) return "—";
  if (tradeInfo.status === "OPEN") {
    if (Number(tradeInfo.barsOpen) === 0) return "ENTRY";
    return "HOLD";
  }
  return "—";
}

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

function computeBtcStateLocal(btcBase, SETTINGS) {
  const cfg = safeObj(SETTINGS?.btc) || {};
  const neutral24Pct = n(cfg.neutral24Pct, 1.0);
  const chg24 = n(btcBase?.chg24, 0);

  if (chg24 >= neutral24Pct) return "BULL";
  if (chg24 <= -neutral24Pct) return "BEAR";
  return "NEUTRAL";
}

function computeStageCap(mode, btcState) {
  const st = normBtcState(btcState);
  const m = String(mode || "").toLowerCase();

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

function btcConfidenceAdjust(mode, btcState, btcBase, SETTINGS) {
  const cfg = safeObj(SETTINGS?.btc) || {};
  const fine1hAbs = n(cfg.fine1hAbsPct, 0.25);
  const boost = n(cfg.confBoost, 4);

  const st = normBtcState(btcState);
  if (st === "NEUTRAL") return { adj: 0, why: "BTC NEUTRAL: no 1h fine-tune" };

  const chg1h = n(btcBase?.chg1h, 0);
  const m = String(mode || "").toLowerCase();

  const wantUp = m === "bull";
  const pos = chg1h >= fine1hAbs;
  const neg = chg1h <= -fine1hAbs;

  if (wantUp && pos) return { adj: +boost, why: `BTC 1h aligns (+${boost})` };
  if (!wantUp && neg) return { adj: +boost, why: `BTC 1h aligns (+${boost})` };

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
// Adaptive entry thresholds
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
// Consistency + scans + prevStage
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

  S[sym] = {
    ...prev,
    scans,
    hist,
    lastSeenAt: nowTs,
    stage: st,
  };

  return {
    state: S,
    prevStage,
    stageScans: scans,
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

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // "bull" or "bear"
    const core = await import(`../lib/_core_${mode}.js`);

    const now = Date.now();

    // BTC
    const btcBase = await fetchBtc();
    const btcState = computeBtcStateLocal(btcBase, core.SETTINGS);
    const btcTune = btcConfidenceAdjust(mode, btcState, btcBase, core.SETTINGS);
    const btc = { ...btcBase, state: btcState, tune: btcTune };

    const cap = computeStageCap(mode, btc.state);
    const allowEntry = cap.cap === false;

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    const cg = await fetchCgTop(core.SETTINGS.CG_TOP);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];
    const openTrades = [];

    const state = (await kv.get(core.keyState(mode))) || {};
    const obMap = await loadObMap(mode);

    const noticesByHook = {};

    for (const c of cg) {
      const radarGate = passRadar(core, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      const sym = up(c.symbol);
      const priceNow = n(c.price, 0);

      let stageBase = stageFromSwing(mode, { ...c, vm });

      // OB
      const ob = await getObForSymbol({ core, mode, symbol: sym, obMap });

      const obTs = n(ob?.ob?.ts ?? ob?.ts, 0);
      const obAge = obTs > 0 ? now - obTs : Number.POSITIVE_INFINITY;
      const obFresh = obTs > 0 && obAge <= OB_MAX_AGE_MS;

      const obValid = !!ob?.valid && obFresh;

      const spreadPct = n(ob?.ob?.spreadPct ?? ob?.spreadPct, 999);
      const depthMinUsd1p = n(ob?.ob?.depthMinUsd1p ?? ob?.depthMinUsd1p, 0);
      const obScore = n(ob?.ob?.score ?? ob?.score, 0);

      const confidenceBase = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid,
      });

      const confidence = Math.max(
        0,
        Math.min(100, n(confidenceBase, 0) + n(btcTune.adj, 0))
      );

      const thr = adaptiveEntryThresholds(core, c, vm);

      // Funnel stage + gates
      let almostGate = "n/a";
      let entryGate = "n/a";

      let stage = stageBase;

      if (cap.cap && (stageBase === "ALMOST" || stageBase === "ENTRY")) {
        stage = "BUILDUP";
        almostGate = `capped: ${cap.capStage}`;
        entryGate = `capped: ${cap.capStage}`;
      } else {
        let obSamples = null;

        if (stageBase === "ALMOST") {
          obSamples = await kv.get(core.keyObSamples(mode, sym));

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
            if (!obSamples) obSamples = await kv.get(core.keyObSamples(mode, sym));

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

            if (!slopeCheck2.ok) entryGate = slopeCheck2.reason || "OB slope failed at ENTRY";
            else if (!pressureOk) entryGate = "Pressure delta contra";
            else if (!score1pOk) entryGate = "1% imbalance weird";
            else {
              stage = "ENTRY";
              entryGate = "passed";
            }
          }
        }
      }

      // ======================================================
      // TRADE ENGINE
      // ======================================================
      const tKey = kTrade(mode, sym);
      const cdKey = kCooldown(mode, sym);

      const cooldown = await kv.get(cdKey);
      const tradeExisting = await kv.get(tKey);

      let tradeInfo = null;

      // OPEN trade: manage
      if (tradeExisting && tradeExisting?.status === "OPEN") {
        const entryPrice = n(tradeExisting.entryPrice, 0);
        const barsOpen = n(tradeExisting.barsOpen, 0) + 1;

        const pnl = calcPnlPct(mode, entryPrice, priceNow);
        const maxPnl = Math.max(n(tradeExisting.maxPnl, 0), pnl);

        const stopPct = stopPctFromRange24(c.range24);

        const hardStopHit =
          String(mode).toLowerCase() === "bear"
            ? priceNow >= entryPrice * (1 + stopPct)
            : priceNow <= entryPrice * (1 - stopPct);

        const obAgainst = obFresh ? isObAgainst(mode, ob) : false;
        const obInvalid = isObInvalidFresh(obValid, obFresh, ob);
        const badNow = obFresh && (obAgainst || obInvalid);
        const obBadStreak = badNow ? n(tradeExisting.obBadStreak, 0) + 1 : 0;

        const obBreakHit = obBadStreak >= 2;
        const timeStopHit = barsOpen >= TIME_STOP_SCANS && maxPnl < TIME_STOP_MAXPNL;

        let exit = null;
        if (hardStopHit) exit = { reason: "HARD_STOP", stopPct, pnl };
        else if (obBreakHit) exit = { reason: "OB_BREAK_2X", obBadStreak, obFresh, obValid, obAgainst, pnl };
        else if (timeStopHit) exit = { reason: "TIME_STOP_NO_MOMENTUM", barsOpen, maxPnl, pnl };

        if (exit) {
          await kv.del(tKey);
          await kv.set(cdKey, { ts: now, reason: exit.reason }, { ex: REENTRY_COOLDOWN_SEC });

          await logSell(mode, {
            ts: now,
            symbol: sym,
            side: String(mode).toLowerCase(),
            reason: exit.reason,
            pnlPct: pnl,
            maxPnlPct: maxPnl,
            entryPrice,
            exitPrice: priceNow,
            barsOpen,
          });

          const hook = stageWebhook("SELL");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `**SELL** • ${exit.reason}  ` +
            `pnl ${fmtPct(pnl * 100, 2)} • max ${fmtPct(maxPnl * 100, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);

          // ✅ voor coin item (maar SELL paneel komt uit sells-log)
          tradeInfo = { status: "CLOSED", exit, pnl, maxPnl, exitAt: now, barsOpen };
        } else {
          const updated = {
            ...tradeExisting,
            barsOpen,
            maxPnl,
            lastPrice: priceNow,
            lastSeenAt: now,
            obBadStreak,
          };

          if (!updated.holdNotified && barsOpen >= HOLD_AFTER_SCANS) {
            const hook = stageWebhook("HOLD");
            const line =
              `**${sym}** (${mode.toUpperCase()})  ` +
              `**HOLD** • trade loopt  ` +
              `pnl ${fmtPct(pnl * 100, 2)} • max ${fmtPct(maxPnl * 100, 2)} • ` +
              `price ${fmtUsd(priceNow, 6)}`;
            pushNotice(noticesByHook, hook, line);
            updated.holdNotified = true;
          }

          await kv.set(tKey, updated, { ex: TRADE_TTL_SEC });

          tradeInfo = {
            status: "OPEN",
            entryPrice,
            entryAt: n(updated.entryAt, 0),
            barsOpen,
            pnl,
            maxPnl,
            stopPct,
            obBadStreak,
          };
        }
      }

      // no OPEN trade: open on ENTRY
      if (!tradeInfo) {
        const inCooldown = !!cooldown;
        const isEntrySignal = stage === "ENTRY" && allowEntry;

        if (isEntrySignal && !inCooldown && priceNow > 0) {
          const tradeObj = {
            status: "OPEN",
            mode,
            symbol: sym,
            entryPrice: priceNow,
            entryAt: now,
            barsOpen: 0,
            maxPnl: 0,
            obBadStreak: 0,
            holdNotified: false,
            lastSeenAt: now,
            lastPrice: priceNow,
            entryConfidence: confidence,
            entryVm: vm,
            entryRange24: c.range24,
          };

          await kv.set(tKey, tradeObj, { ex: TRADE_TTL_SEC });

          const hook = stageWebhook("ENTRY");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `**ENTRY** • instap  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);

          tradeInfo = { status: "OPEN", entryPrice: priceNow, entryAt: now, barsOpen: 0, pnl: 0, maxPnl: 0 };
        }
      }

      // Funnel state
      const prevEntry = safeObj(state[sym]) || {};
      const stFix = updateStateAndConsistency(state, sym, stage, core, now);

      const stageScans = stFix.stageScans;
      const consistency = stFix.consistency;
      const prevStage = up(stFix.prevStage);
      const currStage = up(stage);

      const hasOpenTrade = tradeInfo?.status === "OPEN";

      if (!hasOpenTrade && prevStage) {
        const doNotify = canNotify(prevEntry, now);
        const isFunnelStage = currStage === "RADAR" || currStage === "BUILDUP" || currStage === "ALMOST";

        if (doNotify && isFunnelStage && prevStage !== currStage) {
          const hook = stageWebhook(currStage);
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `${prevStage} → **${currStage}**  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);
          markNotified(state, sym, now);
        }
      }

      // ✅ open trades tabel
      if (tradeInfo?.status === "OPEN") {
        openTrades.push({
          symbol: sym,
          side: String(mode).toLowerCase(),
          entryPrice: n(tradeInfo.entryPrice, 0),
          entryAt: n(tradeInfo.entryAt, 0),
          barsOpen: n(tradeInfo.barsOpen, 0),
          pnlPct: n(tradeInfo.pnl, 0),
          maxPnlPct: n(tradeInfo.maxPnl, 0),
          price: priceNow,
          confidence,
          vm,
        });
      }

      // ✅ VolAcc bestaat nu echt (geen leeg veld)
      const volAcc = vm;

      const item = {
        id: c.id,
        symbol: sym,
        name: c.name,
        price: priceNow,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: +c.change24.toFixed(4),
        change1h: +c.change1h.toFixed(4),
        range24: +c.range24.toFixed(4),
        vm: +vm.toFixed(6),
        volAcc: +volAcc.toFixed(6),

        confidenceBase,
        confidence,
        confidenceBtcAdj: btcTune.adj,

        stage: currStage,

        trade: tradeInfo,
        tradeStatus: pageTradeStatus(tradeInfo),

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

    openTrades.sort((a, b) => b.pnlPct - a.pnlPct || b.maxPnlPct - a.maxPnlPct);

    const discord = await flushNotices(noticesByHook);

    const btcCfg = safeObj(core.SETTINGS?.btc) || {};
    const neutral24Pct = n(btcCfg.neutral24Pct, 1.0);
    const fine1hAbsPct = n(btcCfg.fine1hAbsPct, 0.25);
    const confBoost = n(btcCfg.confBoost, 4);

    // ✅ recent sells voor pagina (KV log)
    const recentSellsRaw = (await kv.get(kSells(mode))) || [];
    const recentSells = Array.isArray(recentSellsRaw)
      ? recentSellsRaw.slice(-SELLS_KEEP).reverse()
      : [];

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      meta: {
        cadence: "30m",
        btcPolicy:
          "24h regime + 1h confidence fine-tune; NEUTRAL/opposite => cap to BUILDUP (prep), maar scan+OB blijven lopen",
        capActive: !!cap.cap,
        capStage: cap.capStage,
        capReason: cap.reason,
        allowEntry,
        neutralZone: `BTC 24h tussen -${neutral24Pct}% en +${neutral24Pct}%`,
        fineTune: `BTC 1h abs >= ${fine1hAbsPct}% => confidence +/-${confBoost}`,
        tradeEngine: {
          enabled: true,
          timeStopScans: TIME_STOP_SCANS,
          timeStopMaxPnlPct: TIME_STOP_MAXPNL * 100,
          reentryCooldownSec: REENTRY_COOLDOWN_SEC,
          tradeTtlSec: TRADE_TTL_SEC,
          sellsLogKey: kSells(mode),
          exits: ["HARD_STOP(range24)", "OB_BREAK_2X(fresh)", "TIME_STOP(no momentum)"],
        },
      },
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
        openTrades: openTrades.length,
        recentSells: recentSells.length,
      },
      funnel: { entry, almost, buildup, radar },

      // ✅ trading tabellen voor pagina
      trading: {
        openTrades,
        recentSells,
      },

      obMap: obMap ? { ok: true, size: Object.keys(obMap).length } : { ok: false },
      discord: {
        enabled: true,
        sent: discord.sent,
        failed: discord.failed,
        errors: (discord.details || []).slice(0, 5),
      },
      note:
        "HOLD komt uit trade OPEN. SELL komt uit KV sells-log (trade:sells:*), dus blijft zichtbaar op de pagina.",
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