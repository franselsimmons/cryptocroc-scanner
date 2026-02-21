import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret, getMode } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${t.slice(0, 160)}`);
  return j;
}

// 1) BTC gate (simpel)
async function fetchBtcGate() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1&sparkline=false&price_change_percentage=24h";
  const arr = await fetchJson(url);
  const b = arr?.[0];
  const chg24 = Number(b?.price_change_percentage_24h || 0);
  const high = Number(b?.high_24h || 0);
  const low = Number(b?.low_24h || 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  let state = "NEUTRAL";
  if (chg24 >= 0.6) state = "BULL";
  if (chg24 <= -0.6) state = "BEAR";

  return { state, chg24: +chg24.toFixed(3), range24: +range24.toFixed(3) };
}

// 2) Universe top coins
async function fetchCgTop(limit) {
  const per = Math.min(250, Math.max(50, Number(limit || 250)));
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=${per}&page=1&sparkline=false&price_change_percentage=1h,24h`;
  const arr = await fetchJson(url);

  return (arr || []).map((c) => {
    const price = Number(c?.current_price || 0);
    const high = Number(c?.high_24h || 0);
    const low = Number(c?.low_24h || 0);
    const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

    return {
      id: c?.id,
      symbol: String(c?.symbol || "").toUpperCase(),
      name: c?.name,
      price,
      volume: Number(c?.total_volume || 0),
      marketCap: Number(c?.market_cap || 0),
      change24: Number(c?.price_change_percentage_24h || 0),
      change1h: Number(c?.price_change_percentage_1h_in_currency || 0),
      range24
    };
  });
}

function passRadar(core, c) {
  const R = core.SETTINGS.radar;
  const vm = core.computeVm(c.volume, c.marketCap);

  if (c.marketCap < R.mcapMin) return { ok: false, why: "mcap too low" };
  if (c.marketCap > R.mcapMax) return { ok: false, why: "mcap too high" };
  if (c.volume < R.volMin) return { ok: false, why: "volume too low" };
  if (vm < R.vmMin) return { ok: false, why: "vm too low" };
  if (Math.abs(c.change24) > R.maxAbsChg24) return { ok: false, why: "chg24 too high" };
  if (c.range24 > R.maxRange24) return { ok: false, why: "range24 too high" };

  return { ok: true, vm };
}

function stageFromSimple(mode, c) {
  // simpel funnel gedrag:
  // - BUILDUP: vm hoog + range redelijk
  // - ALMOST: change24 in jouw richting + vm hoog
  // - ENTRY: ALMOST + OB valid + confidence
  // OB gate gebeurt later (ENTRY check)

  const vm = c.vm;
  const range = c.range24;
  const chg24 = c.change24;

  const wantUp = mode === "bull";
  const inDir = wantUp ? chg24 >= 0.6 : chg24 <= -0.6;

  if (vm >= 0.22 && range <= 18 && inDir) return "ALMOST";
  if (vm >= 0.16 && range <= 22) return "BUILDUP";
  return "RADAR";
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // "bull" of "bear"
    const core = await import(`../lib/_core_${mode}.js`);

    const now = Date.now();
    const btc = await fetchBtcGate();

    // BTC soft gate
    if (btc.state !== "NEUTRAL") {
      if (mode === "bull" && btc.state === "BEAR") {
        const out = { ok: true, ts: now, mode, btc, counts: { entry:0, almost:0, buildup:0, radar:0 }, funnel: { entry:[], almost:[], buildup:[], radar:[] }, note: "Blocked by BTC gate" };
        await kv.set(core.keyLatest(mode), out);
        res.statusCode = 200; res.setHeader("content-type", "application/json; charset=utf-8");
        return res.end(JSON.stringify(out));
      }
      if (mode === "bear" && btc.state === "BULL") {
        const out = { ok: true, ts: now, mode, btc, counts: { entry:0, almost:0, buildup:0, radar:0 }, funnel: { entry:[], almost:[], buildup:[], radar:[] }, note: "Blocked by BTC gate" };
        await kv.set(core.keyLatest(mode), out);
        res.statusCode = 200; res.setHeader("content-type", "application/json; charset=utf-8");
        return res.end(JSON.stringify(out));
      }
    }

    const cg = await fetchCgTop(core.SETTINGS.CG_TOP);

    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];

    // state (optioneel; voor health count)
    const state = (await kv.get(core.keyState(mode))) || {};

    for (const c of cg) {
      const radarGate = passRadar(core, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      let stageBase = stageFromSimple(mode, { ...c, vm });

      // OB result (als aanwezig)
      const ob = await kv.get(core.keyObResult(mode, c.symbol));
      const obValid = !!ob?.valid;
      const spreadPct = Number(ob?.ob?.spreadPct ?? ob?.spreadPct ?? 999);
      const depthMinUsd1p = Number(ob?.ob?.depthMinUsd1p ?? ob?.depthMinUsd1p ?? 0);
      const obScore = Number(ob?.ob?.score ?? ob?.score ?? 0);

      const confidence = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid
      });

      // ✅ OB samples (alleen nodig zodra coin richting ALMOST/ENTRY gaat)
      let obSamples = null;

      // ✅ ALMOST slope gate (verplicht om überhaupt ALMOST te zijn)
      let almostGate = "n/a";
      if (stageBase === "ALMOST") {
        obSamples = await kv.get(core.keyObSamples(mode, c.symbol));

        // core.checkObSlopeGate is in jouw core files toegevoegd
        const slopeCheck = typeof core.checkObSlopeGate === "function"
          ? core.checkObSlopeGate({ stage: "almost", mode, obSamples, settings: core.SETTINGS })
          : { ok: true };

        if (!slopeCheck.ok) {
          // geen ALMOST als slope faalt -> terug naar BUILDUP (dus hij kan later wél bijna-entry worden)
          stageBase = "BUILDUP";
          almostGate = slopeCheck.reason || "OB slope failed in ALMOST";
        } else {
          almostGate = "OK";
        }
      }

      // ENTRY gate (strict)
      let stage = stageBase;
      let entryGate = "n/a";

      if (stageBase === "ALMOST") {
        const E = core.SETTINGS.entry;

        if (!ob) entryGate = "OB missing";
        else if (!obValid) entryGate = "OB validating";
        else if (confidence < E.minConfidence) entryGate = "Confidence < min";
        else if (spreadPct > E.spreadMaxPct) entryGate = "Spread too wide";
        else if (depthMinUsd1p < E.depthMinUsd1p) entryGate = "Depth too thin (<$)";
        else if (Math.abs(obScore) < E.obScoreMin) entryGate = "OB score too low";
        else {
          // ✅ ENTRY slope gate (opnieuw verplicht)
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
          reason: String(ob.reason || ""),
          score: Number(obScore),
          spreadPct: Number(spreadPct),
          depthMinUsd1p: Number(depthMinUsd1p)
        } : { status: "none" },
        why: {
          almostGate,
          entryGate
        }
      };

      if (stage === "ENTRY") entry.push(item);
      else if (stage === "ALMOST") almost.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else radar.push(item);

      state[item.symbol] = { lastSeenAt: now, stage };
    }

    // sort
    entry.sort((a,b)=>b.confidence-a.confidence || b.vm-a.vm);
    almost.sort((a,b)=>b.confidence-a.confidence || b.vm-a.vm);
    buildup.sort((a,b)=>b.vm-a.vm);
    radar.sort((a,b)=>b.vm-a.vm);

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      counts: { entry: entry.length, almost: almost.length, buildup: buildup.length, radar: radar.length },
      funnel: { entry, almost, buildup, radar }
    };

    await kv.set(core.keyLatest(mode), result);
    await kv.set(core.keyState(mode), state);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}