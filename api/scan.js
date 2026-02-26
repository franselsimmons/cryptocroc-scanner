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
  try { j = JSON.parse(t); } catch {}
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

// ✅ OB max age (stale gate)
const OB_MAX_AGE_MS = 75 * 60 * 1000; // 75 min

// --------------------
// 1) BTC gate (swing-proof)
// --------------------
async function fetchBtcGate() {
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

  let state = "NEUTRAL";

  if (chg1h >= 0.15) state = "BULL";
  else if (chg1h <= -0.15) state = "BEAR";
  else {
    if (chg24 >= 0.35) state = "BULL";
    if (chg24 <= -0.35) state = "BEAR";
  }

  return {
    state,
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
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${per}&page=1&sparkline=false&price_change_percentage=1h,24h`;

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
      symbol: String(c?.symbol || "").toUpperCase(),
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
  if (c.marketCap > n(R.mcapMax, Number.MAX_SAFE_INTEGER)) return { ok: false, why: "mcap too high" };
  if (c.volume < n(R.volMin, 0)) return { ok: false, why: "volume too low" };
  if (vm < n(R.vmMin, 0)) return { ok: false, why: "vm too low" };
  if (Math.abs(c.change24) > n(R.maxAbsChg24, 999)) return { ok: false, why: "chg24 too high" };
  if (c.range24 > n(R.maxRange24, 999)) return { ok: false, why: "range24 too high" };

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
  const inDir = wantUp ? ch1h >= 0.20 : ch1h <= -0.20;

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
  const sym = String(symbol || "").toUpperCase();
  if (obMap && obMap[sym]) return obMap[sym];
  return await kv.get(core.keyObResult(mode, sym));
}

// --------------------
// ✅ Adaptive entry thresholds (minder strict, maar slim)
// --------------------
function adaptiveEntryThresholds(core, c, vm) {
  const base = core?.SETTINGS?.entry || {};
  const mc = n(c?.marketCap, 0);

  // Defaults (als je niks instelt)
  const tiers = Array.isArray(base?.adaptiveTiers) ? base.adaptiveTiers : [
    { maxMc: 50_000_000,  minConf: 58, spreadMax: 1.20, depth1pMin: 8_000,   obScoreMin: 0.04 },
    { maxMc: 200_000_000, minConf: 60, spreadMax: 1.05, depth1pMin: 20_000,  obScoreMin: 0.05 },
    { maxMc: 1_000_000_000,minConf: 62, spreadMax: 0.90, depth1pMin: 60_000, obScoreMin: 0.06 },
    { maxMc: Infinity,     minConf: 64, spreadMax: 0.80, depth1pMin: 120_000,obScoreMin: 0.07 },
  ];

  const t = tiers.find(x => mc <= n(x.maxMc, Infinity)) || tiers[tiers.length - 1];

  // VM bonus: als VM hoog is, iets minder confidence nodig (want aandacht is er echt)
  const vmBonus = vm >= 0.80 ? 4 : vm >= 0.50 ? 2 : 0;

  const minConfidence = Math.max(0, n(t.minConf, n(base.minConfidence, 62)) - vmBonus);

  // Clamp met jouw base settings (zodat jij altijd de “bovenkant” in de hand houdt)
  const spreadMaxPct = Math.max(n(base.spreadMaxPct, 1.00), n(t.spreadMax, 1.00)); // grotere = soepeler
  const depthMinUsd1p = Math.min(
    n(base.depthMinUsd1p, 50_000), // als jij base hoger zet, blijf jij streng
    n(t.depth1pMin, 50_000)
  );
  const obScoreMin = Math.min(
    n(base.obScoreMin, 0.07),
    n(t.obScoreMin, 0.07)
  );

  return {
    minConfidence,
    spreadMaxPct,
    depthMinUsd1p,
    obScoreMin,
  };
}

// --------------------
// ✅ Consistency (fix voor 0/0 + undefined)
// --------------------
function updateStateAndConsistency(stateObj, symbol, stageBase, core) {
  const S = stateObj || {};
  const sym = String(symbol || "").toUpperCase();
  const entryCfg = core?.SETTINGS?.entry || {};
  const need = Math.max(2, n(entryCfg.samplesNeed, 6));
  const minAgree = Math.max(1, n(entryCfg.minAgree, 4));

  const prev = safeObj(S[sym]) || {};
  const scans = n(prev.scans, 0) + 1;

  const histPrev = Array.isArray(prev.hist) ? prev.hist : [];
  const hist = histPrev.concat([String(stageBase || "").toUpperCase()]).slice(-Math.max(need, 12));

  // “zelfde stage” in de laatste hist
  const same = hist.filter(x => x === String(stageBase || "").toUpperCase()).length;
  const total = hist.length;
  const ratio = total > 0 ? same / total : 0;

  const ok = total >= need && same >= minAgree;

  S[sym] = {
    ...prev,
    scans,
    hist,
    lastSeenAt: Date.now(),
    stage: stageBase,
  };

  return {
    state: S,
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
    const btc = await fetchBtcGate();

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    // --------------------
    // BTC soft gate
    // --------------------
    if (btc.state !== "NEUTRAL") {
      if (mode === "bull" && btc.state === "BEAR") {
        const out = {
          ok: true, ts: now, mode, btc,
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
          ok: true, ts: now, mode, btc,
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

    for (const c of cg) {
      const radarGate = passRadar(core, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;

      let stageBase = stageFromSwing(mode, { ...c, vm });

      // ✅ OB lookup
      const ob = await getObForSymbol({ core, mode, symbol: c.symbol, obMap });

      // ✅ stale gate
      const obTs = n(ob?.ob?.ts ?? ob?.ts, 0);
      const obAge = obTs > 0 ? (now - obTs) : Number.POSITIVE_INFINITY;
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

      // ✅ thresholds (adaptive)
      const thr = adaptiveEntryThresholds(core, c, vm);

      // ✅ state / consistency / scans fix
      const stFix = updateStateAndConsistency(state, c.symbol, stageBase, core);
      // stFix.state is same object ref, but keep explicit
      // eslint-disable-next-line no-unused-vars
      const stageScans = stFix.stageScans;
      const consistency = stFix.consistency;

      // ✅ OB samples alleen ophalen als nodig
      let obSamples = null;

      // ✅ ALMOST slope gate (verplicht)
      let almostGate = "n/a";
      if (stageBase === "ALMOST") {
        obSamples = await kv.get(core.keyObSamples(mode, c.symbol));

        const slopeCheck = typeof core.checkObSlopeGate === "function"
          ? core.checkObSlopeGate({ stage: "almost", mode, obSamples, settings: core.SETTINGS })
          : { ok: true };

        if (!slopeCheck.ok) {
          stageBase = "BUILDUP";
          almostGate = slopeCheck.reason || "OB slope failed in ALMOST";
        } else {
          almostGate = "OK";
        }
      }

      // ✅ ENTRY gate (nu: minder hard, maar wél kwaliteitsbewust)
      let stage = stageBase;
      let entryGate = "n/a";

      if (stageBase === "ALMOST") {
        if (!ob) entryGate = "OB missing";
        else if (!obFresh) entryGate = `OB stale (${Math.round(obAge / 1000)}s)`;
        else if (!obValid) entryGate = "OB validating";
        else if (confidence < n(thr.minConfidence, 0)) entryGate = `Confidence < ${thr.minConfidence}`;
        else if (spreadPct > n(thr.spreadMaxPct, 999)) entryGate = `Spread > ${thr.spreadMaxPct}%`;
        else if (depthMinUsd1p < n(thr.depthMinUsd1p, 0)) entryGate = `Depth1% < $${thr.depthMinUsd1p}`;
        else if (Math.abs(obScore) < n(thr.obScoreMin, 0)) entryGate = `OB score < ${thr.obScoreMin}`;
        else {
          if (!obSamples) obSamples = await kv.get(core.keyObSamples(mode, c.symbol));

          const slopeCheck2 = typeof core.checkObSlopeGate === "function"
            ? core.checkObSlopeGate({ stage: "entry", mode, obSamples, settings: core.SETTINGS })
            : { ok: true };

          // ✅ extra “pro” signal (als aanwezig uit sampler)
          const pressureDelta = n(ob?.ob?.pressureDeltaUsd ?? ob?.pressureDeltaUsd, 0);
          const score1p = n(ob?.ob?.score1p ?? ob?.score1p, 0);

          // bull: je wil positieve druk; bear: negatieve druk (niet verplicht, maar helpt)
          const pressureOk = mode === "bull" ? pressureDelta >= 0 : pressureDelta <= 0;
          const score1pOk = mode === "bull" ? score1p >= -0.10 : score1p <= 0.10; // mild, vooral tegen rare spikes

          if (!slopeCheck2.ok) {
            entryGate = slopeCheck2.reason || "OB slope failed at ENTRY";
          } else if (!pressureOk) {
            entryGate = "Pressure delta contra";
          } else if (!score1pOk) {
            entryGate = "1% imbalance weird";
          } else {
            stage = "ENTRY";
            entryGate = "OK";
          }
        }
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

        stage,
        stageScans,
        consistency,

        // ✅ thresholds teruggeven zodat UI weet wat “goed” is voor deze coin
        req: {
          minConfidence: thr.minConfidence,
          spreadMaxPct: thr.spreadMaxPct,
          depthMinUsd1p: thr.depthMinUsd1p,
          obScoreMin: thr.obScoreMin,
        },

        ob: ob ? {
          valid: !!ob.valid,
          fresh: !!obFresh,
          stale: !!ob.stale,
          ageSec: obTs > 0 ? Math.round(obAge / 1000) : null,
          reason: String(ob.reason || ""),
          score: Number(obScore),
          spreadPct: Number(spreadPct),
          depthMinUsd1p: Number(depthMinUsd1p),
          lor: Number(n(ob?.ob?.lor ?? ob?.lor, 1)),
          // extra pro fields (als sampler ze vult)
          score1p: n(ob?.ob?.score1p ?? ob?.score1p, 0),
          score05p: n(ob?.ob?.score05p ?? ob?.score05p, 0),
          pressureDeltaUsd: n(ob?.ob?.pressureDeltaUsd ?? ob?.pressureDeltaUsd, 0),
          slopeScore: n(ob?.slopeScore ?? ob?.ob?.slopeScore ?? ob?.slope ?? 0, 0),
          slopeDepth1p: n(ob?.slopeDepth1p ?? ob?.ob?.slopeDepth1p ?? 0, 0),
          ts: obTs || null,
        } : { status: "none" },

        why: { almostGate, entryGate },
      };

      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    entry.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    almost.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    buildup.sort((a, b) => b.vm - a.vm);
    radar.sort((a, b) => b.vm - a.vm);

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
      note: "Adaptive ENTRY thresholds + real consistency/scans + pro OB fields.",
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