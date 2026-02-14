import { kv } from "@vercel/kv";
import { CFG, fetchJSON, mapCoin, vmRatio } from "./_core.js";

export const config = { runtime: "nodejs" };

// ---------------- Bitget symbols (USDT) ----------------
async function fetchBitgetUsdtSymbols() {
  // V2 endpoint (meest modern)
  // Verwacht: data = [{ symbol: "BTCUSDT", ... }, ...]
  try {
    const r = await fetch("https://api.bitget.com/api/v2/spot/public/symbols");
    const j = await r.json();
    const arr = j?.data;
    if (Array.isArray(arr) && arr.length) {
      const set = new Set();
      for (const it of arr) {
        const sym = (it?.symbol || it?.symbolName || "").toUpperCase();
        if (sym.endsWith("USDT")) set.add(sym.replace("USDT", ""));
      }
      if (set.size) return set;
    }
  } catch {}

  // V1 fallback (products)
  // Verwacht: data = [{ symbolName: "BTCUSDT", ... }, ...]
  const r = await fetch("https://api.bitget.com/api/spot/v1/public/products");
  const j = await r.json();
  const arr = j?.data;
  if (!Array.isArray(arr) || !arr.length) return new Set();

  const set = new Set();
  for (const it of arr) {
    const sym = (it?.symbolName || it?.symbol || "").toUpperCase();
    if (sym.endsWith("USDT")) set.add(sym.replace("USDT", ""));
  }
  return set;
}

async function getBitgetUniverse() {
  const key = "bitget:usdt_symbols:v1";
  const cached = await kv.get(key);
  if (cached && Array.isArray(cached)) return new Set(cached);

  const set = await fetchBitgetUsdtSymbols();
  await kv.set(key, Array.from(set));
  // 24h cache
  await kv.expire(key, 60 * 60 * 24);
  return set;
}

// ---------------- CoinGecko markets ----------------
async function getMarketsPage(page) {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    `?vs_currency=usd&order=volume_desc&per_page=250&page=${page}` +
    "&price_change_percentage=24h";
  return fetchJSON(url);
}

async function getMarketsTop(maxCoins = 500) {
  const pages = Math.ceil(maxCoins / 250);
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const arr = await getMarketsPage(p);
    if (Array.isArray(arr)) all.push(...arr);
  }
  return all;
}

// ---------------- BTC gate ----------------
async function getBtcInfo() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&price_change_percentage=24h";
  const arr = await fetchJSON(url);
  const btc = Array.isArray(arr) ? arr[0] : null;
  if (!btc) return { state: "UNKNOWN", reason: "BTC fetch failed" };

  const price = Number(btc.current_price);
  const high = Number(btc.high_24h);
  const low = Number(btc.low_24h);
  const change24 = Number(btc.price_change_percentage_24h);
  const range24 = (price > 0 && high > 0 && low > 0) ? ((high - low) / price) * 100 : null;

  // jouw v1 defaults
  const bull =
    change24 >= CFG.btcBullChange24 &&
    range24 != null &&
    range24 >= CFG.btcRangeMin &&
    range24 <= CFG.btcBullRangeMax;

  const bear =
    change24 <= -CFG.btcBearChange24 && // let op: CFG.btcBearChange24 is positief getal
    range24 != null &&
    range24 >= CFG.btcRangeMin &&
    range24 <= CFG.btcBearRangeMax;

  let state = "NEUTRAL";
  let reason = "BTC gate neutral";
  if (bull) { state = "BULL"; reason = "BTC bullish"; }
  else if (bear) { state = "BEAR"; reason = "BTC bearish"; }

  return { state, reason, price, change24, range24 };
}

// ---------------- helpers ----------------
function addRange24(c) {
  const price = Number(c.current_price);
  const high = Number(c.high_24h);
  const low = Number(c.low_24h);
  const range24 = (price > 0 && high > 0 && low > 0) ? ((high - low) / price) * 100 : null;
  return range24;
}

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, "http://localhost");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase(); // bull/bear

    // 1) BTC gate info (altijd teruggeven, zodat je ziet WAAROM het leeg is)
    const btc = await getBtcInfo();

    // 2) Universe: alleen coins die écht op Bitget USDT bestaan
    const bitgetSet = await getBitgetUniverse();

    // 3) Markets ophalen
    const markets = await getMarketsTop(500);

    // 4) Map + base metrics
    const mapped = markets.map((raw) => {
      const m = mapCoin(raw);
      return {
        ...m,
        name: raw?.name || "",
        range24: addRange24(raw)
      };
    });

    // 5) Base filter (BREED RADAR)
    const base = mapped.filter((c) => {
      if (!bitgetSet.has(c.symbol)) return false;

      if (c.marketCap < CFG.pool.mcapMin) return false;
      if (c.volume < CFG.pool.volMinRadar) return false;
      if (c.vm < CFG.pool.vmMinRadar) return false;

      if (Math.abs(c.change24) > CFG.pool.maxAbsChange24) return false;

      if (Number.isFinite(c.range24) && c.range24 > CFG.pool.maxRange24) return false;

      return true;
    });

    // RADAR vullen (altijd!)
    const radar = base
      .sort((a, b) => (b.vm - a.vm) || (b.volume - a.volume))
      .slice(0, CFG.pool.radarMax);

    // 6) BTC gate bepaalt of we doorgaan
    //    Belangrijk: als BTC NEUTRAL -> leeg output, maar met BTC reason erbij.
    if (
      (mode === "bull" && btc.state !== "BULL") ||
      (mode === "bear" && btc.state !== "BEAR")
    ) {
      const result = {
        ts: Date.now(),
        mode,
        btc,
        radar: [],
        buildup: [],
        almost: [],
        entry: []
      };
      await kv.set(`latest:${mode}`, result);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }

    // 7) BUILDUP
    const buildup = radar.filter((c) => {
      if (mode === "bull" && c.change24 < CFG.stage.buildupChangeMin) return false;
      if (mode === "bear" && c.change24 > -CFG.stage.buildupChangeMin) return false;

      if (c.vm < CFG.stage.buildupVmMin) return false;
      if (c.volume < CFG.stage.buildupVolMin) return false;
      return true;
    });

    // 8) ALMOST (v1 simpel: strengere vm/vol; priceFlat/volAcc doen we later netjes met stage-memory)
    const almost = buildup.filter((c) => {
      if (c.vm < CFG.stage.almostVmMin) return false;
      if (c.volume < CFG.stage.almostVolMin) return false;
      return true;
    });

    // 9) ENTRY (OB gate: alleen als OB sampler al “valid” heeft gezet in KV)
    const entry = [];
    for (const c of almost) {
      const ob = await kv.get(`ob:result:${mode}:${c.symbol}`);
      if (!ob?.valid) continue;

      // harde gates
      if ((ob.avgScore ?? 0) < CFG.ob.scoreMinAbs) continue;
      if ((ob.ob?.spreadPct ?? 999) > CFG.ob.spreadMaxEntry) continue;
      if ((ob.ob?.lor ?? 1) > CFG.ob.largestOrderRatioMax) continue;

      // entry-range
      const absCh = Math.abs(c.change24);
      const inNormal = absCh >= CFG.stage.entryAbsMin && absCh <= CFG.stage.entryAbsMax;
      const inLate = absCh > CFG.stage.entryAbsMax && absCh <= CFG.stage.entryLateAbsMax;

      if (inNormal) {
        entry.push(c);
        continue;
      }

      // late-move exception (22–35%) alleen bij sterk vm + sterke ob
      if (inLate) {
        if (c.vm >= CFG.stage.entryLateVmMin && (ob.avgScore ?? 0) >= CFG.stage.entryLateObMin) {
          entry.push(c);
        }
      }
    }

    const result = {
      ts: Date.now(),
      mode,
      btc,
      radar,
      buildup,
      almost,
      entry
    };

    await kv.set(`latest:${mode}`, result);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e) }));
  }
}