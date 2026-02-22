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
const OB_MAX_AGE_MS = 15 * 60 * 1000; // 15 min

// --------------------
// 1) BTC gate (simpel)
// --------------------
async function fetchBtcGate() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1&sparkline=false&price_change_percentage=24h";

  const arr = await fetchJson(url);
  const b = arr?.[0];

  const chg24 = n(b?.price_change_percentage_24h, 0);
  const high = n(b?.high_24h, 0);
  const low = n(b?.low_24h, 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  let state = "NEUTRAL";
  if (chg24 >= 0.6) state = "BULL";
  if (chg24 <= -0.6) state = "BEAR";

  return { state, chg24: +chg24.toFixed(3), range24: +range24.toFixed(3) };
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

    return {
      id: c?.id,
      symbol: String(c?.symbol || "").toUpperCase(),
      name: c?.name,
      price,
      volume: n(c?.total_volume, 0),
      marketCap: n(c?.market_cap, 0),
      change24: n(c?.price_change_percentage_24h, 0),
      change1h: n(c?.price_change_percentage_1h_in_currency, 0),
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
// Stage logic (simpel)
// --------------------
function stageFromSimple(mode, c) {
  const vm = c.vm;
  const range = c.range24;
  const chg24 = c.change24;

  const wantUp = mode === "bull";
  const inDir = wantUp ? chg24 >= 0.6 : chg24 <= -0.6;

  if (vm >= 0.22 && range <= 18 && inDir) return "ALMOST";
  if (vm >= 0.16 && range <= 22) return "BUILDUP";
  return "RADAR";
}

// --------------------
// OB map loader (sneller/goedkoper)
// --------------------
async function loadObMap(mode) {
  // map_refresh schrijft: `ob:map:${mode}` -> { ts, size, map }
  const blob = await kv.get(`ob:map:${mode}`);
  const m = safeObj(blob)?.map;
  return safeObj(m) || null;
}

// --------------------
// OB lookup: eerst map, anders KV
// --------------------
async function getObForSymbol({ core, mode, symbol, obMap }) {
  // 1) map lookup
  if (obMap && obMap[symbol]) {
    return obMap[symbol];
  }
  // 2) fallback naar individuele key (blijft werken als map niet draait)
  return await kv.get(core.keyObResult(mode, symbol));
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

    // ✅ 1x load ob map (als die er is)
    const obMap = await loadObMap(mode);

    for (const c of cg) {
      const radarGate = passRadar(core, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      let stageBase = stageFromSimple(mode, { ...c, vm });

      // ✅ OB lookup (map eerst, anders KV)
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

      // ✅ ENTRY gate (strict)
      let stage = stageBase;
      let entryGate = "n/a";

      if (stageBase === "ALMOST") {
        const E = core.SETTINGS.entry;

        if (!ob) entryGate = "OB missing";
        else if (!obFresh) entryGate = `OB stale (${Math.round(obAge / 1000)}s)`;
        else if (!obValid) entryGate = "OB validating";
        else if (confidence < n(E.minConfidence, 0)) entryGate = "Confidence < min";
        else if (spreadPct > n(E.spreadMaxPct, 999)) entryGate = "Spread too wide";
        else if (depthMinUsd1p < n(E.depthMinUsd1p, 0)) entryGate = "Depth too thin (<$)";
        else if (Math.abs(obScore) < n(E.obScoreMin, 0)) entryGate = "OB score too low";
        else {
          if (!obSamples) obSamples = await kv.get(core.keyObSamples(mode, c.symbol));

          const slopeCheck2 = typeof core.checkObSlopeGate === "function"
            ? core.checkObSlopeGate({ stage: "entry", mode, obSamples, settings: core.SETTINGS })
            : { ok: true };

          if (!slopeCheck2.ok) {
            entryGate = slopeCheck2.reason || "OB slope failed at ENTRY";
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
        ob: ob ? {
          valid: !!ob.valid,
          fresh: !!obFresh,
          ageSec: obTs > 0 ? Math.round(obAge / 1000) : null,
          reason: String(ob.reason || ""),
          score: Number(obScore),
          spreadPct: Number(spreadPct),
          depthMinUsd1p: Number(depthMinUsd1p),
          slope: ob?.slope ?? null,
        } : { status: "none" },
        why: { almostGate, entryGate },
      };

      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);

      state[item.symbol] = { lastSeenAt: now, stage };
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