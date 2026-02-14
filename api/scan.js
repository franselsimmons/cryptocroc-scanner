import { kv } from "@vercel/kv";
import {
  CFG, fetchJSON, vmRatio, calcRangePct,
  now, clamp, minutesToMs
} from "./_core.js";

export const config = { runtime: "nodejs" };

// =======================
// CoinGecko
// =======================
async function getMarkets() {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets` +
    `?vs_currency=usd&order=volume_desc&per_page=${CFG.poolMax}&page=1` +
    `&price_change_percentage=24h`;

  return fetchJSON(url, { timeoutMs: 15_000 });
}

function mapCoin(c) {
  const price = Number(c.current_price);
  const volume = Number(c.total_volume);
  const marketCap = Number(c.market_cap);

  const change24 = Number(c.price_change_percentage_24h);
  const range24 = calcRangePct(c.low_24h, c.high_24h, price);

  return {
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name || "",
    price,
    volume,
    marketCap,
    change24,
    range24,
    vm: vmRatio(volume, marketCap)
  };
}

// =======================
// Bitget symbols (USDT spot) cache in KV
// =======================
async function getBitgetUsdtSet() {
  const cached = await kv.get("bitget:symbols:usdt");
  if (cached?.ts && (now() - cached.ts) < (CFG.bitgetSymbolsCacheSec * 1000) && Array.isArray(cached.list)) {
    return new Set(cached.list);
  }

  // Bitget public products (v1)
  const url = "https://api.bitget.com/api/spot/v1/public/products";
  const j = await fetchJSON(url, { timeoutMs: 15_000 });

  const arr = j?.data || [];
  const set = new Set();
  for (const p of arr) {
    // in praktijk is dit vaak "BTCUSDT"
    const sym = (p?.symbolName || p?.symbol || "").toUpperCase();
    if (sym.endsWith("USDT")) set.add(sym.replace("USDT", ""));
  }

  await kv.set("bitget:symbols:usdt", { ts: now(), list: [...set] });
  return set;
}

// =======================
// BTC Gate (CoinGecko data)
// =======================
function btcStateFromMarkets(markets) {
  const btc = markets.find(x => String(x.symbol || "").toUpperCase() === "BTC");
  if (!btc) return { state: "NEUTRAL", change24: 0, range24: 0 };

  const price = Number(btc.current_price);
  const change24 = Number(btc.price_change_percentage_24h);
  const range24 = calcRangePct(btc.low_24h, btc.high_24h, price);

  // bull
  if (
    change24 >= CFG.btcGate.bull.change24Min &&
    range24 >= CFG.btcGate.bull.range24Min &&
    range24 <= CFG.btcGate.bull.range24Max
  ) return { state: "BULL", change24, range24 };

  // bear
  if (
    change24 <= CFG.btcGate.bear.change24Max &&
    range24 >= CFG.btcGate.bear.range24Min &&
    range24 <= CFG.btcGate.bear.range24Max
  ) return { state: "BEAR", change24, range24 };

  return { state: "NEUTRAL", change24, range24 };
}

// =======================
// State (KV memory)
// =======================
function emptyState() {
  return {
    coins: {}, // symbol -> info
    // info:
    // { stage, enteredAt, scansInStage, cooldownUntil, sidePassHistory:[], pricesHistory:[], volHistory:[], obSamples:[], obPeakAbs:0 }
  };
}

function getCoinState(state, sym) {
  state.coins[sym] ||= {
    stage: "RADAR",
    enteredAt: now(),
    scansInStage: 0,
    cooldownUntil: 0,
    sidePassHistory: [],
    pricesHistory: [],
    volHistory: [],
    obSamples: [],
    obPeakAbs: 0
  };
  return state.coins[sym];
}

function pushLimited(arr, v, max) {
  arr.push(v);
  if (arr.length > max) arr.shift();
}

function stageTimeoutMs(stage) {
  if (stage === "RADAR") return minutesToMs(CFG.stage.radarTimeoutMin);
  if (stage === "BUILDUP") return minutesToMs(CFG.stage.buildupTimeoutMin);
  if (stage === "ALMOST") return minutesToMs(CFG.stage.almostTimeoutMin);
  if (stage === "ENTRY") return minutesToMs(CFG.stage.entryTimeoutMin);
  if (stage === "COOLDOWN") return minutesToMs(CFG.stage.cooldownMin);
  return minutesToMs(60);
}

// =======================
// Orderbook fetch for sampling (server-side gate)
// =======================
async function fetchObSample(symbol) {
  const url = `https://api.bitget.com/api/spot/v1/market/depth?symbol=${symbol}USDT&limit=${CFG.ob.depthLimit}`;
  const j = await fetchJSON(url, { timeoutMs: 12_000 });
  const data = j?.data;
  const bids = data?.bids;
  const asks = data?.asks;
  if (!bids?.length || !asks?.length) throw new Error("No OB data");

  const bid = Number(bids[0][0]);
  const ask = Number(asks[0][0]);
  const mid = (bid + ask) / 2;
  const spreadPct = ((ask - bid) / mid) * 100;

  const { total: bidUsd, largest: bidLargest } = sumDepth(bids, mid, CFG.ob.depthPct, true);
  const { total: askUsd, largest: askLargest } = sumDepth(asks, mid, CFG.ob.depthPct, false);

  const score = (bidUsd - askUsd) / (bidUsd + askUsd);
  const largestRatio = Math.max(bidLargest, askLargest) / Math.max(1, (bidUsd + askUsd));

  return {
    ts: now(),
    score,
    spreadPct,
    bidUsd,
    askUsd,
    largestOrderRatio: largestRatio
  };
}

function sumDepth(levels, mid, pct, isBid) {
  const limit = isBid ? mid * (1 - pct) : mid * (1 + pct);
  let total = 0;
  let largest = 0;

  for (const [price, size] of levels) {
    const p = Number(price);
    const s = Number(size);
    if (!p || !s) continue;

    if (isBid && p < limit) break;
    if (!isBid && p > limit) break;

    const usd = p * s;
    total += usd;
    if (usd > largest) largest = usd;
  }
  return { total, largest };
}

function obValid(samples, mode) {
  const winMs = CFG.ob.samplesWindowSec * 1000;
  const recent = samples.filter(s => (now() - s.ts) <= winMs);

  if (recent.length < CFG.ob.samplesNeed) return { ok: false };

  // 3 samples pakken (laatste 3)
  const last3 = recent.slice(-CFG.ob.samplesNeed);

  // stale check per sample
  for (const s of last3) {
    if ((now() - s.ts) > (CFG.ob.staleSec * 1000)) return { ok: false };
    if (s.spreadPct > CFG.ob.spreadMaxEntry) return { ok: false };
    if (s.largestOrderRatio > CFG.ob.largestOrderRatioMax) return { ok: false };
  }

  const dir = (x) => x > 0 ? 1 : x < 0 ? -1 : 0;
  const dirs = last3.map(s => dir(s.score));
  const sum = dirs.reduce((a,b)=>a+b,0);

  // bull: meeste positief, bear: meeste negatief
  if (mode === "bull") {
    const positives = dirs.filter(d => d > 0).length;
    if (positives < 2) return { ok: false };
    const avg = last3.reduce((a,s)=>a+s.score,0)/last3.length;
    if (avg < CFG.ob.obScoreMin) return { ok: false };
    return { ok: true, score: avg, spreadPct: last3[last3.length-1].spreadPct };
  } else {
    const negatives = dirs.filter(d => d < 0).length;
    if (negatives < 2) return { ok: false };
    const avg = last3.reduce((a,s)=>a+s.score,0)/last3.length;
    if (avg > -CFG.ob.obScoreMin) return { ok: false };
    return { ok: true, score: avg, spreadPct: last3[last3.length-1].spreadPct };
  }
}

// =======================
// Main scan
// =======================
export default async function handler(req, res) {
  try {
    // block manual calls unless CRON_SECRET matches
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret) {
      const auth = req.headers?.authorization || "";
      // /api/cron calls scan internally (bypasses this), maar directe users call wordt geblokt:
      // (als handler direct via internet wordt aangeroepen)
      if (req?.headers && auth && auth !== `Bearer ${cronSecret}`) {
        res.statusCode = 401;
        res.end("Unauthorized");
        return;
      }
    }

    const u = new URL(req.url, "http://localhost");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase();

    // data ophalen
    const [marketsRaw, bitgetSet] = await Promise.all([
      getMarkets(),
      getBitgetUsdtSet()
    ]);

    const btc = btcStateFromMarkets(marketsRaw);

    // BTC gate: bull endpoint werkt alleen als BTC BULL, bear endpoint alleen als BTC BEAR
    const needState = mode === "bull" ? "BULL" : "BEAR";
    if (btc.state !== needState) {
      const empty = {
        ts: now(),
        mode,
        btc,
        marketState: "NEUTRAL",
        entry: [],
        hold: [],
        sell: [],
        radar: [],
        counts: { entry: 0, hold: 0, sell: 0, radar: 0 }
      };
      await kv.set(`latest:${mode}`, empty);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(empty));
      return;
    }

    // map & pool filters + bitget-first
    const mapped = marketsRaw.map(mapCoin).filter(c => c.symbol && bitgetSet.has(c.symbol));

    const pool = mapped.filter(c => {
      if (c.marketCap < CFG.pool.mcapMin) return false;
      if (c.volume < CFG.pool.volMin) return false;
      if (c.vm < CFG.pool.vmMin) return false;
      if (Math.abs(c.change24) > CFG.pool.absChange24Max) return false;
      if (c.range24 > CFG.pool.range24Max) return false;
      return true;
    });

    // load state
    const stateKey = `state:${mode}`;
    const state = (await kv.get(stateKey)) || emptyState();

    // per coin memory update
    for (const c of pool) {
      const st = getCoinState(state, c.symbol);

      pushLimited(st.pricesHistory, c.price, 12);
      pushLimited(st.volHistory, c.volume, 12);

      // side pass history (bull: change24 >0, bear: change24 <0)
      const sidePass = mode === "bull" ? (c.change24 > 0) : (c.change24 < 0);
      pushLimited(st.sidePassHistory, sidePass ? 1 : 0, CFG.buildup.consistencyWindow);

      // cooldown check
      if (st.cooldownUntil && now() < st.cooldownUntil) {
        st.stage = "COOLDOWN";
      }
    }

    // verwijder coins die niet meer in pool zitten (opschonen)
    const poolSyms = new Set(pool.map(x => x.symbol));
    for (const sym of Object.keys(state.coins)) {
      if (!poolSyms.has(sym)) delete state.coins[sym];
    }

    // helpers voor stage checks
    const bySym = Object.fromEntries(pool.map(c => [c.symbol, c]));

    const entryList = [];
    const holdList = [];
    const sellList = [];
    const radarList = [];

    // OB calls budget
    let obCalls = 0;

    // Stage machine
    for (const c of pool) {
      const st = getCoinState(state, c.symbol);

      // timeout -> cooldown
      const age = now() - st.enteredAt;
      if (st.stage !== "COOLDOWN" && age > stageTimeoutMs(st.stage)) {
        st.stage = "COOLDOWN";
        st.enteredAt = now();
        st.scansInStage = 0;
        st.cooldownUntil = now() + stageTimeoutMs("COOLDOWN");
      }

      // stage scan count
      st.scansInStage += 1;

      // consistency
      const hist = st.sidePassHistory || [];
      const consistency = hist.length ? (hist.reduce((a,b)=>a+b,0) / hist.length) : 0;

      // priceFlat (last 6 scans range)
      const ph = st.pricesHistory || [];
      let priceFlat = 999;
      if (ph.length >= CFG.almost.priceFlatWindow) {
        const w = ph.slice(-CFG.almost.priceFlatWindow);
        const lo = Math.min(...w);
        const hi = Math.max(...w);
        priceFlat = ((hi - lo) / Math.max(1e-9, w[w.length-1])) * 100;
      }

      // volAcc ratio (last3 / prev3)
      const vh = st.volHistory || [];
      let volAccRatio = 1.0;
      if (vh.length >= 6) {
        const last3 = vh.slice(-3).reduce((a,b)=>a+b,0) / 3;
        const prev3 = vh.slice(-6,-3).reduce((a,b)=>a+b,0) / 3;
        volAccRatio = prev3 > 0 ? (last3 / prev3) : 1.0;
      }

      // stage logic (we houden intern RADAR/BUILDUP/ALMOST/ENTRY/HOLD/SELL/COOLDOWN)
      const sideOk =
        mode === "bull" ? (c.change24 >= +CFG.buildup.change24MinAbs) : (c.change24 <= -CFG.buildup.change24MinAbs);

      const buildupOk =
        sideOk &&
        c.vm >= CFG.buildup.vmMin &&
        c.volume >= CFG.buildup.volMin &&
        consistency >= CFG.buildup.consistencyMin;

      const almostOk =
        buildupOk &&
        c.vm >= CFG.almost.vmMin &&
        c.volume >= CFG.almost.volMin &&
        priceFlat <= CFG.almost.priceFlatMax &&
        volAccRatio >= CFG.almost.volAccRatioMin;

      // Fast track (BUILDUP -> ENTRY) bij extreem OB + volume
      const fastTrackCandidate = buildupOk && c.volume >= CFG.entry.fastTrack.volMin;

      // OB sampling alleen voor: ALMOST of fasttrackCandidate (max calls per scan)
      let obGate = { ok: false };
      if ((almostOk || fastTrackCandidate) && obCalls < CFG.ob.maxCallsPerScan) {
        try {
          const sample = await fetchObSample(c.symbol);
          obCalls++;

          // store sample
          st.obSamples ||= [];
          st.obSamples.push(sample);

          // trim to last ~10
          if (st.obSamples.length > 10) st.obSamples = st.obSamples.slice(-10);

          obGate = obValid(st.obSamples, mode);

          // peakAbs update (voor HOLD trailing)
          if (obGate.ok) {
            const absScore = Math.abs(obGate.score);
            st.obPeakAbs = Math.max(st.obPeakAbs || 0, absScore);
          }
        } catch {
          // ignore OB fail (blijft gewoon geen entry)
        }
      } else {
        // ook zonder nieuwe sample kunnen we valid checken met bestaande
        if (st.obSamples?.length) {
          obGate = obValid(st.obSamples, mode);
        }
      }

      // ENTRY checks (change window + late move exception)
      const absCh = Math.abs(c.change24);
      const inNormal = absCh >= CFG.entry.change24AbsMin && absCh <= CFG.entry.change24AbsMax;
      const inLate = absCh > CFG.entry.change24AbsMax && absCh <= CFG.entry.lateMoveAbsMax;

      const lateOk =
        inLate &&
        c.vm >= CFG.entry.lateMoveVmMin &&
        (
          (mode === "bull" && obGate.ok && obGate.score >= CFG.entry.lateMoveObMin) ||
          (mode === "bear" && obGate.ok && obGate.score <= -CFG.entry.lateMoveObMin)
        );

      const entryOk =
        obGate.ok &&
        (inNormal || lateOk) &&
        (almostOk || (fastTrackCandidate && (
          (mode === "bull" && obGate.score >= CFG.entry.fastTrack.obMin) ||
          (mode === "bear" && obGate.score <= -CFG.entry.fastTrack.obMin)
        )));

      // HOLD/SELL logic: als ooit ENTRY geweest -> trailing, anders stage machine
      const isEntryStage = st.stage === "ENTRY" || st.stage === "HOLD";

      if (isEntryStage) {
        const peak = st.obPeakAbs || 0;
        const curAbs = obGate.ok ? Math.abs(obGate.score) : 0;

        const holdOk =
          peak > 0 &&
          curAbs >= peak * CFG.hold.trailKeep &&
          absCh <= CFG.hold.overextendedAbsChange;

        const sellOk =
          (!holdOk) ||
          curAbs <= CFG.hold.sellNeutralAbs ||
          absCh > CFG.hold.overextendedAbsChange;

        if (sellOk) {
          st.stage = "SELL";
          sellList.push(packCoin(c, st, mode, obGate, { consistency, priceFlat, volAccRatio }));
          // na SELL meteen cooldown (anti flip)
          st.stage = "COOLDOWN";
          st.enteredAt = now();
          st.scansInStage = 0;
          st.cooldownUntil = now() + stageTimeoutMs("COOLDOWN");
          continue;
        }

        st.stage = "HOLD";
        holdList.push(packCoin(c, st, mode, obGate, { consistency, priceFlat, volAccRatio }));
        continue;
      }

      // Stage transitions
      if (st.stage === "COOLDOWN") {
        // in cooldown: alleen tonen in radar met label
        radarList.push(packCoin(c, st, mode, obGate, { consistency, priceFlat, volAccRatio }));
        continue;
      }

      // ALMOST verplicht route (maar fasttrack kan overslaan als OB extreem)
      if (entryOk) {
        st.stage = "ENTRY";
        st.enteredAt = now();
        st.scansInStage = 0;
        entryList.push(packCoin(c, st, mode, obGate, { consistency, priceFlat, volAccRatio }));
        continue;
      }

      if (almostOk) {
        if (st.stage !== "ALMOST") {
          st.stage = "ALMOST";
          st.enteredAt = now();
          st.scansInStage = 0;
        }
        radarList.push(packCoin(c, st, mode, obGate, { consistency, priceFlat, volAccRatio }));
        continue;
      }

      if (buildupOk) {
        if (st.stage !== "BUILDUP") {
          st.stage = "BUILDUP";
          st.enteredAt = now();
          st.scansInStage = 0;
        }
        radarList.push(packCoin(c, st, mode, obGate, { consistency, priceFlat, volAccRatio }));
        continue;
      }

      // default RADAR
      if (st.stage !== "RADAR") {
        st.stage = "RADAR";
        st.enteredAt = now();
        st.scansInStage = 0;
      }
      radarList.push(packCoin(c, st, mode, obGate, { consistency, priceFlat, volAccRatio }));
    }

    // sorteren (ENTRY hoogste eerst)
    entryList.sort((a,b) => (Math.abs(b.obScore||0) - Math.abs(a.obScore||0)) || (b.vm - a.vm));
    holdList.sort((a,b) => (Math.abs(b.obScore||0) - Math.abs(a.obScore||0)) || (b.vm - a.vm));
    sellList.sort((a,b) => (Math.abs(b.change24) - Math.abs(a.change24)));
    radarList.sort((a,b) => (b.vm - a.vm));

    // save state + latest
    await kv.set(stateKey, state);

    const out = {
      ts: now(),
      mode,
      btc,
      marketState: mode === "bull" ? "BULL" : "BEAR",
      entry: entryList.slice(0, 60),
      hold: holdList.slice(0, 60),
      sell: sellList.slice(0, 60),
      radar: radarList.slice(0, 180),
      counts: {
        pool: pool.length,
        entry: entryList.length,
        hold: holdList.length,
        sell: sellList.length,
        radar: radarList.length
      }
    };

    await kv.set(`latest:${mode}`, out);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: String(e) }));
  }
}

function packCoin(c, st, mode, obGate, extras) {
  return {
    symbol: c.symbol,
    name: c.name,
    price: c.price,
    volume: c.volume,
    marketCap: c.marketCap,
    change24: c.change24,
    range24: c.range24,
    vm: c.vm,

    stage: st.stage,
    obScore: obGate.ok ? obGate.score : null,
    obSpread: obGate.ok ? obGate.spreadPct : null,
    ...extras
  };
}
