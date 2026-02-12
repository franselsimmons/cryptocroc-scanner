const { kv } = require("@vercel/kv");

const COINGECKO = "https://api.coingecko.com/api/v3";

// ---------- helpers ----------
function nowTs() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

function safeNum(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function mean(arr) { return arr.length ? sum(arr) / arr.length : 0; }
function stdev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) * (x - m)));
  return Math.sqrt(v);
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status} ${url} ${t.slice(0, 120)}`);
  }
  return r.json();
}

// ---------- config (jij kan later tunen, maar dit is “strak” en logisch) ----------
const CFG = {
  pool: {
    mcapMin: 3_000_000,
    mcapMax: 400_000_000,
    volMin: 250_000,
    vmMin: 0.10
  },
  bands: { lowP: 0.10, highP: 0.90 },
  memory: { maxHist: 30, consistencyWindow: 6 },
  stages: {
    minScansToLeaveRadar: 2,
    minTotalScansForEntry: 5,
    entryVolMin: 1_500_000,
    entryVmMin: 0.28
  },
  timing: {
    rangeMin: 4.2,
    rangeMax: 25,
    vmTiming: 0.14,
    ctlBullMin: 0.70,
    ctlBearMax: 0.30
  },
  ob: {
    depthPct: 0.02,
    zWindow: 50,
    zBull: 1.0,
    zBear: -1.0,
    maxCallsPerScan: 10
  }
};

// ---------- market data ----------
async function getMarketPage(page) {
  const url =
    `${COINGECKO}/coins/markets?vs_currency=usd&order=volume_desc&per_page=250&page=${page}` +
    `&price_change_percentage=24h&sparkline=false`;
  return fetchJson(url);
}

async function getMarketUniverse() {
  // 2 pages = 500 coins (snel genoeg voor Vercel). Later kan je 3/4 doen.
  const [p1, p2] = await Promise.all([getMarketPage(1), getMarketPage(2)]);
  return [...p1, ...p2].filter(Boolean);
}

function poolFilter(c) {
  const mcap = safeNum(c.market_cap, 0);
  const vol = safeNum(c.total_volume, 0);
  const price = safeNum(c.current_price, 0);
  const high24 = safeNum(c.high_24h, 0);
  const low24 = safeNum(c.low_24h, 0);
  const ch24 = safeNum(c.price_change_percentage_24h, 0);

  if (!price || !mcap || !vol) return null;

  const vm = mcap > 0 ? (vol / mcap) : 0;
  const range = low24 > 0 ? ((high24 - low24) / low24) * 100 : 0;
  const ctl = high24 > 0 ? (price / high24) : 0;

  if (mcap < CFG.pool.mcapMin) return null;
  if (mcap > CFG.pool.mcapMax) return null;
  if (vol < CFG.pool.volMin) return null;
  if (vm < CFG.pool.vmMin) return null;

  return {
    id: c.id,
    symbol: String(c.symbol || "").toUpperCase(),
    name: c.name,
    price,
    mcap,
    vol,
    vm,
    ch24,
    high24,
    low24,
    range,
    ctl
  };
}

function timingScore(side, coin) {
  let s = 0;

  if (side === "bull") {
    if (coin.ch24 > 0) s += 1;
    if (coin.vm >= CFG.timing.vmTiming) s += 1;
    if (coin.range >= CFG.timing.rangeMin && coin.range <= CFG.timing.rangeMax) s += 1;
    if (coin.ctl >= CFG.timing.ctlBullMin) s += 1;
  } else {
    if (coin.ch24 < 0) s += 1;
    if (coin.vm >= CFG.timing.vmTiming) s += 1;
    if (coin.range >= CFG.timing.rangeMin && coin.range <= CFG.timing.rangeMax) s += 1;
    if (coin.ctl <= CFG.timing.ctlBearMax) s += 1;
  }

  return s;
}

function computeHistStats(hist) {
  const w = CFG.memory.consistencyWindow;
  const last = hist.slice(-w);

  const passSidePct = last.length
    ? last.filter(x => x.passSide).length / last.length
    : 0;

  const prices = last.map(x => x.price).filter(Number.isFinite);
  const vols = last.map(x => x.vol).filter(Number.isFinite);

  const flat = prices.length
    ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100
    : null;

  const volsA = vols.slice(-3);
  const volsB = vols.slice(0, Math.max(0, vols.length - 3));
  const va = mean(volsA);
  const vb = mean(volsB);
  const volAcc = vb > 0 ? (va - vb) / vb : 0;

  return { consistency: passSidePct, flatness: flat, volAcc };
}

// ---------- ORDERBOOK (Bitget)
// Let op: we doen dit “veilig”: als Bitget faalt, is het geen harde error in UI.
async function fetchBitgetOrderbook(symbolUpper) {
  // Meestal spot pairs: BTCUSDT. We pakken USDT.
  const pair = `${symbolUpper}USDT`;

  // Bitget endpoint kan variëren per versie; we proberen 2 routes.
  const tries = [
    `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(pair)}&type=step0`,
    `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(pair)}&limit=50`
  ];

  for (const url of tries) {
    try {
      const j = await fetchJson(url);

      // Normaliseren: zoek bids/asks arrays
      const data = j.data || j?.data?.[0] || j?.result || j;
      const bids = (data.bids || data.bid || data?.bidsList || []).map(x => [Number(x[0]), Number(x[1])]).filter(x => x[0] && x[1]);
      const asks = (data.asks || data.ask || data?.asksList || []).map(x => [Number(x[0]), Number(x[1])]).filter(x => x[0] && x[1]);

      if (bids.length && asks.length) {
        return { pair, bids, asks, source: url };
      }
    } catch (e) {
      // try next
    }
  }

  return null;
}

function obScoreFromDepth(ob, midPrice, depthPct) {
  if (!ob || !midPrice) return null;
  const lo = midPrice * (1 - depthPct);
  const hi = midPrice * (1 + depthPct);

  const bidUsd = sum(ob.bids.filter(([p]) => p >= lo && p <= midPrice).map(([p, q]) => p * q));
  const askUsd = sum(ob.asks.filter(([p]) => p <= hi && p >= midPrice).map(([p, q]) => p * q));
  const denom = bidUsd + askUsd;
  if (denom <= 0) return null;

  return (bidUsd - askUsd) / denom;
}

async function getObZScore(side, coin, obScore) {
  if (obScore === null) return { z: null, ok: false, reason: "no_ob_score" };

  const key = `ob:${coin.id}`;
  const list = (await kv.get(key)) || [];
  const next = [...list, { ts: nowTs(), v: obScore }].slice(-CFG.ob.zWindow);

  // save back
  await kv.set(key, next);

  const values = next.map(x => x.v).filter(Number.isFinite);
  const m = mean(values);
  const sd = stdev(values);

  if (!sd) return { z: 0, ok: false, reason: "no_sd_yet" };

  const z = (obScore - m) / sd;

  if (side === "bull") return { z, ok: z >= CFG.ob.zBull, reason: z >= CFG.ob.zBull ? "ok" : "z_too_low" };
  return { z, ok: z <= CFG.ob.zBear, reason: z <= CFG.ob.zBear ? "ok" : "z_too_high" };
}

// ---------- stages ----------
function decideSide(coin, lowBand, highBand) {
  if (lowBand === null || highBand === null) return null;
  if (coin.ch24 >= highBand) return "bull";
  if (coin.ch24 <= lowBand) return "bear";
  return null;
}

function nextStage(currentStage, coin, stats, tScore, side, obGateOk) {
  // stages: RADAR -> BUILDUP -> ALMOST -> ENTRY
  const { minScansToLeaveRadar, minTotalScansForEntry, entryVolMin, entryVmMin } = CFG.stages;

  // base gates
  const entryBase = coin.vol >= entryVolMin && coin.vm >= entryVmMin;

  if (!currentStage) return "RADAR";

  if (currentStage === "RADAR") {
    if (coin.totalScans < minScansToLeaveRadar) return "RADAR";
    // promote to BUILDUP if stable
    if (tScore >= 2 && stats.consistency >= 0.82) return "BUILDUP";
    return "RADAR";
  }

  if (currentStage === "BUILDUP") {
    if (tScore < 2) return "RADAR"; // terug bij zwakte
    if (stats.flatness !== null && stats.flatness <= 4.0 && stats.volAcc >= 0.20) return "ALMOST";
    return "BUILDUP";
  }

  if (currentStage === "ALMOST") {
    if (tScore < 2) return "BUILDUP";
    if (coin.totalScans >= minTotalScansForEntry && tScore >= 3 && entryBase && obGateOk) return "ENTRY";
    return "ALMOST";
  }

  if (currentStage === "ENTRY") {
    // als base wegvalt -> ALMOST
    if (!entryBase) return "ALMOST";
    return "ENTRY";
  }

  return "RADAR";
}

// ---------- main scan ----------
async function scanSide(side) {
  const universe = await getMarketUniverse();

  // pool filter
  const pool = universe.map(poolFilter).filter(Boolean);

  // bands
  const chArr = pool.map(c => c.ch24).filter(Number.isFinite).sort((a, b) => a - b);
  const lowBand = percentile(chArr, CFG.bands.lowP);
  const highBand = percentile(chArr, CFG.bands.highP);

  // take only coins that match side
  const candidates = pool
    .map(c => {
      const s = decideSide(c, lowBand, highBand);
      if (!s) return null;
      if (s !== side) return null;
      return c;
    })
    .filter(Boolean);

  // limit for speed
  const coins = candidates.slice(0, 80);

  // stage lists
  const stage = { ENTRY: [], ALMOST: [], BUILDUP: [], RADAR: [] };

  // Orderbook calls limiter
  let obCalls = 0;

  for (const c of coins) {
    const memKey = `mem:${side}:${c.id}`;
    const mem = (await kv.get(memKey)) || { stage: null, totalScans: 0, scansInStage: 0, hist: [] };

    // passSide is “we zitten nog steeds in deze side”
    const passSide = true;

    const histNext = [...(mem.hist || []), { ts: nowTs(), price: c.price, vol: c.vol, vm: c.vm, passSide }].slice(-CFG.memory.maxHist);
    const stats = computeHistStats(histNext);

    const tScore = timingScore(side, c);

    // Orderbook gate alleen bij ALMOST->ENTRY poging (of als al bijna)
    let ob = null;
    let obScore = null;
    let obZ = { z: null, ok: false, reason: "skipped" };

    const aboutToNeedOB = (mem.stage === "ALMOST") || (mem.stage === "ENTRY");
    const wantOB = aboutToNeedOB && obCalls < CFG.ob.maxCallsPerScan;

    if (wantOB) {
      obCalls += 1;
      ob = await fetchBitgetOrderbook(c.symbol);
      if (ob) {
        const bestBid = ob.bids[0]?.[0] || null;
        const bestAsk = ob.asks[0]?.[0] || null;
        const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : c.price;
        obScore = obScoreFromDepth(ob, mid, CFG.ob.depthPct);
        obZ = await getObZScore(side, c, obScore);
      } else {
        obZ = { z: null, ok: false, reason: "bitget_no_pair_or_failed" };
      }
    }

    // ob gate ok?
    const obGateOk = (mem.stage !== "ALMOST") ? true : (obZ.ok === true);

    // update scans/stage counters
    const totalScans = (mem.totalScans || 0) + 1;

    // stage transitions
    const newStage = nextStage(mem.stage || "RADAR", { ...c, totalScans }, stats, tScore, side, obGateOk);

    let scansInStage = (mem.scansInStage || 0);
    if ((mem.stage || "RADAR") === newStage) scansInStage += 1;
    else scansInStage = 1;

    const memNext = {
      stage: newStage,
      totalScans,
      scansInStage,
      hist: histNext
    };

    await kv.set(memKey, memNext);

    // coin payload for UI
    const out = {
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      price: c.price,
      ch24: c.ch24,
      vm: c.vm,
      vol: c.vol,
      range: c.range,
      ctl: c.ctl,
      timingScore: tScore,
      stats: {
        consistency: stats.consistency,
        flatness: stats.flatness,
        volAcc: stats.volAcc
      },
      mem: {
        stage: newStage,
        totalScans,
        scansInStage
      },
      ob: ob ? {
        pair: ob.pair,
        z: obZ.z,
        ok: obZ.ok,
        reason: obZ.reason,
        score: obScore
      } : {
        pair: null,
        z: obZ.z,
        ok: obZ.ok,
        reason: obZ.reason,
        score: obScore
      }
    };

    stage[newStage].push(out);
  }

  // Sort: ENTRY bovenaan op “sterkte”
  function strength(x) {
    return (x.timingScore * 10) + (x.vm * 5) + (x.stats?.volAcc || 0) * 10 - Math.abs(x.stats?.flatness || 0);
  }

  for (const k of Object.keys(stage)) {
    stage[k].sort((a, b) => strength(b) - strength(a));
  }

  return {
    ok: true,
    side,
    ts: nowTs(),
    bands: { low: lowBand, high: highBand, items: coins.length },
    stage
  };
}

async function runScanBoth() {
  const [bull, bear] = await Promise.all([
    scanSide("bull"),
    scanSide("bear")
  ]);

  await kv.set("latest:bull", bull);
  await kv.set("latest:bear", bear);

  return { bull, bear };
}

module.exports = { scanSide, runScanBoth };
