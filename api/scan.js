// /api/scan.js
import { kv } from "@vercel/kv";
import {
  RUNTIME_CONFIG,
  SETTINGS,
  requireSecret,
  keyLatest,
  keyState,
  keyReset,
  fetchCoinGeckoTop,
  fetchBTCGate,
  getBitgetSpotUsdtSymbols,
  nextDesiredStage,
  stageRank,
  webhookForStage,
  sendDiscord,
  fmtCoinLine,
} from "./_core.js";

export const config = RUNTIME_CONFIG;

export default async function handler(req, res) {
  try {
    // scan endpoint is protected (zelfde als cron)
    if (!requireSecret(req, res)) return;

    const mode = (req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      return res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
    }

    // BTC gate
    const btc = await fetchBTCGate();
    const wanted = mode === "bull" ? "BULL" : "BEAR";

    // Universe
    const symbolsSet = await getBitgetSpotUsdtSymbols();
    const all = await fetchCoinGeckoTop();
    const coins = all.filter((c) => symbolsSet.has(c.symbol));

    // State + resetAt
    const resetAt = (await kv.get(keyReset(mode))) || 0;
    const state = (await kv.get(keyState(mode))) || {}; // { [symbol]: {stage, stageScans, enteredAt, priceHist[]} }

    const now = Date.now();

    // Als BTC niet in de juiste state is -> output leeg + bewaren (zodat UI “NEUTRAL” ziet)
    if (btc.state !== wanted) {
      const empty = {
        ok: true,
        ts: now,
        epoch: Math.floor(now / 1000),
        mode,
        btc,
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
        funnel: { radar: [], buildup: [], almost: [], entry: [] },
        note: `BTC gate: ${btc.state} (needed ${wanted})`,
      };
      await kv.set(keyLatest(mode), empty);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(empty));
    }

    // Build funnel lists
    const radar = [];
    const buildup = [];
    const almost = [];

    // Stage updates + discord on “new in stage”
    for (const c of coins) {
      const sym = c.symbol;
      const prev = state[sym] || { stage: "RADAR", stageScans: 0, enteredAt: now, priceHist: [] };

      // als coin-state ouder is dan resetAt -> force reset voor deze coin
      const prevEntered = Number(prev.enteredAt || 0);
      const wasReset = prevEntered < resetAt;

      const priceHist = Array.isArray(prev.priceHist) ? prev.priceHist.slice(-6) : [];
      priceHist.push(c.price);
      const desired = nextDesiredStage(c, mode, priceHist);

      let stage = prev.stage || "RADAR";
      let stageScans = Number(prev.stageScans || 0);
      let enteredAt = Number(prev.enteredAt || now);

      // HARD RESET per coin
      if (wasReset) {
        stage = "RADAR";
        stageScans = 0;
        enteredAt = now;
      }

      // Als coin niet meer door RADAR komt -> eruit
      if (desired === "OUT") {
        delete state[sym];
        continue;
      }

      // ==== GEEN OVERSLAAN LOGICA ====
      // - Je mag max 1 stage omhoog per scan
      // - En pas als stageScans >= minScansPerStage
      const prevRank = stageRank(stage);
      const desiredRank = stageRank(desired);

      let nextStage = stage;

      if (desiredRank > prevRank) {
        // wil omhoog
        if (stageScans >= SETTINGS.minScansPerStage) {
          // maar slechts 1 stap
          if (desiredRank === prevRank + 1) nextStage = desired;
          else {
            // bijvoorbeeld RADAR -> ALMOST mag niet, wordt BUILDUP
            nextStage = prevRank === 1 ? "BUILDUP" : "ALMOST";
          }
        }
      } else if (desiredRank < prevRank) {
        // omlaag mag direct (veilig)
        nextStage = desired;
      }

      // update scans
      if (nextStage === stage) {
        stageScans += 1;
      } else {
        // stage changed
        stage = nextStage;
        stageScans = 1;
        enteredAt = now;

        // Discord: alleen als coin “nieuw binnenkomt” in een stage
        const hook = webhookForStage(stage);
        if (hook) {
          const msg = fmtCoinLine(c, mode, stage);
          await sendDiscord(hook, msg);
        }
      }

      // save
      state[sym] = { stage, stageScans, enteredAt, priceHist };

      // push into funnel lists (UI)
      const item = {
        symbol: c.symbol,
        name: c.name,
        price: c.price,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: c.change24,
        range24: c.range24,
        vm: c.vm,
        stage,
        stageScans,
      };

      if (stage === "RADAR") radar.push(item);
      else if (stage === "BUILDUP") buildup.push(item);
      else if (stage === "ALMOST") almost.push(item);
    }

    // sort + limit radar
    radar.sort((a, b) => b.vm - a.vm);
    buildup.sort((a, b) => b.vm - a.vm);
    almost.sort((a, b) => b.vm - a.vm);

    const radarLimited = radar.slice(0, SETTINGS.RADAR_LIMIT);

    const result = {
      ok: true,
      ts: now,
      epoch: Math.floor(now / 1000),
      mode,
      btc,
      counts: {
        entry: 0, // OB/ELITE later
        almost: almost.length,
        buildup: buildup.length,
        radar: radarLimited.length,
      },
      funnel: {
        entry: [],
        almost,
        buildup,
        radar: radarLimited,
      },
    };

    // >>> DIT IS DE BELANGRIJKE KOPPELING <<<
    await kv.set(keyLatest(mode), result);
    await kv.set(keyState(mode), state);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}