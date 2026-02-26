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
  // ENTRY -> ELITE kanaal
  if (stageUpper === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE;

  if (stageUpper === "ALMOST") return process.env.DISCORD_WEBHOOK_ALMOST;
  if (stageUpper === "BUILDUP") return process.env.DISCORD_WEBHOOK_BUILDUP;
  if (stageUpper === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;

  // voorbereid voor later:
  if (stageUpper === "HOLD") return process.env.DISCORD_WEBHOOK_HOLD;
  if (stageUpper === "SELL") return process.env.DISCORD_WEBHOOK_SELL;

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

  // Discord limiet is o.a. message size; we sturen per webhook in blokken
  for (const url of urls) {
    const lines = noticesByHook[url] || [];
    if (!lines.length) continue;

    const CHUNK = 15; // max regels per bericht (veilig)
    for (let i = 0; i < lines.length; i += CHUNK) {
      const part = lines.slice(i, i + CHUNK);
      const msg = part.join("\n");

      const r = await sendDiscord(url, msg);
      if (r.ok) {
        sent++;
      } else {
        failed++;
        details.push({ webhook: url, ...r });
      }
    }
  }

  return { sent, failed, details };
}

// --------------------
// 1) BTC fetch (alleen data, state komt uit core)
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
// ✅ Consistency + scans (geen 0/0, geen undefined)
// + return prevStage zodat we transitions kunnen detecteren
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

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // "bull" of "bear"
    const core = await import(`../lib/_core_${mode}.js`);

    const now = Date.now();

    // BTC fetch + state via core
    const btcBase = await fetchBtc();
    const btcState =
      typeof core.computeBtcState === "function"
        ? core.computeBtcState(btcBase, core.SETTINGS)
        : btcBase.state || "NEUTRAL";

    const btc = { ...btcBase, state: btcState };

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    // --------------------
    // BTC soft gate (block alleen als BTC duidelijk opposite is)
    // --------------------
    if (btc.state !== "NEUTRAL") {
      if (mode === "bull" && btc.state === "BEAR") {
        const out = {
          ok: true,
          ts: now,
          mode,
          btc,
          counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
          funnel: { entry: [], almost: [], buildup: [], radar: [] },
          note: "Blocked by BTC gate",
        };
        await kv.set(core.keyLatest(mode), out);
        res.statusCode = 200;
        return res.end(JSON.stringify(out));
      }

      if (mode === "bear" && btc.state === "BULL") {
        const out = {
          ok: true,
          ts: now,
          mode,
          btc,
          counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
          funnel: { entry: [], almost: [], buildup: [], radar: [] },
          note: "Blocked by BTC gate",
        };
        await kv.set(core.keyLatest(mode), out);
        res.statusCode = 200;
        return res.end(JSON.stringify(out));
      }
    }

    // --------------------
    // Fetch universe
    // --------------------
    const cg = await fetchCgTop(core.SETTINGS.CG_TOP);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];

    const state = (await kv.get(core.keyState(mode))) || {};
    const obMap = await loadObMap(mode);

    // ✅ collect discord notices grouped per webhook
    const noticesByHook = {};

    for (const c of cg) {
      const radarGate = passRadar(core, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;

      // basis stage op swing
      let stageBase = stageFromSwing(mode, { ...c, vm });

      // OB lookup
      const ob = await getObForSymbol({ core, mode, symbol: c.symbol, obMap });

      // stale gate
      const obTs = n(ob?.ob?.ts ?? ob?.ts, 0);
      const obAge = obTs > 0 ? now - obTs : Number.POSITIVE_INFINITY;
      const obFresh = obTs > 0 && obAge <= OB_MAX_AGE_MS;

      const obValid = !!ob?.valid && obFresh;

      const spreadPct = n(ob?.ob?.spreadPct ?? ob?.spreadPct, 999);
      const depthMinUsd1p = n(ob?.ob?.depthMinUsd1p ?? ob?.depthMinUsd1p, 0);
      const obScore = n(ob?.ob?.score ?? ob?.score, 0);

      const confidence = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid,
      });

      // thresholds (adaptive, uit core tiers)
      const thr = adaptiveEntryThresholds(core, c, vm);

      // OB samples alleen ophalen als nodig
      let obSamples = null;

      // ALMOST slope gate (verplicht)
      let almostGate = "n/a";
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
          almostGate = slopeCheck.reason || "OB slope failed in ALMOST";
        } else {
          almostGate = "passed";
        }
      }

      // ENTRY gate
      let stage = stageBase;
      let entryGate = "n/a";

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

      // ✅ consistency/scans + prevStage (met definitieve stage)
      const stFix = updateStateAndConsistency(state, c.symbol, stage, core, now);
      const stageScans = stFix.stageScans;
      const consistency = stFix.consistency;
      const prevStage = stFix.prevStage;

      // ✅ DISCORD: alleen melding als coin van stage verandert
      // - geen melding bij “eerste keer gezien” (prevStage leeg)
      // - ENTRY altijd mee (valt hier automatisch onder stage change)
      const currStage = up(stage);
      const prev = up(prevStage);

      const changed = !!prev && prev !== currStage;
      if (changed) {
        const hook = stageWebhook(currStage);

        const line =
          `**${up(c.symbol)}** (${mode.toUpperCase()})  ` +
          `${prev} → **${currStage}**  ` +
          `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
          `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
          `price ${fmtUsd(c.price, 6)}`;

        pushNotice(noticesByHook, hook, line);
      }

      const item = {
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        price: c.price,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: +c.change24.toFixed(4),
        change1h: +c.change1h.toFixed(4),
        range24: +c.range24.toFixed(4),
        vm: +vm.toFixed(6),
        confidence,

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

    // ✅ stuur discord meldingen (geclusterd per webhook)
    const discord = await flushNotices(noticesByHook);

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
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
        // laat errors kort zien (handig in logs / response)
        errors: (discord.details || []).slice(0, 5),
      },
      note:
        "Discord only on stage change (prev->new). ENTRY goes to ELITE. First-seen coins do not notify.",
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