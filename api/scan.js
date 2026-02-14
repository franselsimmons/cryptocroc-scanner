import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// ============================
// DEFAULTS v1 (zoals besproken)
// ============================
const DEFAULTS = {
  // pool
  mcapMin: 5_000_000,
  mcapMax: 400_000_000, // als je dit later los wil laten: zet op null
  radarVolMin: 500_000,
  radarVmMin: 0.15,
  absChange24Max: 35,   // %
  range24Max: 30,       // %

  // BTC gate
  btcChangeGate: 0.8, // %
  btcBullRangeMin: 2,
  btcBullRangeMax: 8,
  btcBearRangeMin: 2,
  btcBearRangeMax: 10,

  // stages
  minScansPerStage: 2,

  // buildup
  buildupChangeMin: 1.2, // bull
  buildupVmMin: 0.22,
  buildupVolMin: 1_200_000,

  // almost
  almostVmMin: 0.26,
  almostVolMin: 2_000_000,
  priceFlatMax: 6.5, // % (range over last N scans)
  volAccMin: 0.12,   // (last3 vs prev3) - relatief

  // entry
  entryChangeMin: 2,
  entryChangeMax: 22,
  lateMoveMax: 35,
  lateMoveVmMin: 0.35,
  lateMoveObMin: 0.12,  // strenger zoals je wilde
  spreadMaxEntry: 0.55, // %
  obScoreMin: 0.06,     // killers maar niet té strak

  // OB sampling
  obSampleNeed: 3,
  obSampleWindowMs: 90_000,
  obStaleMs: 15_000,
};

// ============================
// DISCORD (4 tabellen)
// ============================
const WEBHOOK_RADAR  = process.env.DISCORD_WEBHOOK_RADAR  || "";
const WEBHOOK_BUILDUP= process.env.DISCORD_WEBHOOK_BUILDUP|| "";
const WEBHOOK_ALMOST = process.env.DISCORD_WEBHOOK_ALMOST || "";
const WEBHOOK_ELITE  = process.env.DISCORD_WEBHOOK_ELITE  || ""; // ENTRY/HOLD/SELL

async function sendDiscord(webhookUrl, content) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(content),
    });
  } catch (_) {
    // nooit crashen op discord
  }
}

function stageWebhook(stage) {
  if (stage === "RADAR") return WEBHOOK_RADAR;
  if (stage === "BUILDUP") return WEBHOOK_BUILDUP;
  if (stage === "ALMOST") return WEBHOOK_ALMOST;
  return WEBHOOK_ELITE; // ENTRY/HOLD/SELL
}

function fmtUsd(n) {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function pct(n) {
  if (!Number.isFinite(n)) return "-";
  return `${n.toFixed(2)}%`;
}

// ============================
// AUTH (zelfde stijl als cron)
// ============================
function requireCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization || "";
  return auth === `Bearer ${secret}`;
}

// ============================
// DATA: CoinGecko + Bitget universe
// ============================
async function fetchJson(url) {
  const r = await fetch(url, { headers: { "accept": "application/json" } });
  if (!r.ok) throw new Error(`fetch fail ${r.status} ${url}`);
  return await r.json();
}

// CoinGecko markets (top 250)
async function getMarkets() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&order=volume_desc&per_page=250&page=1" +
    "&sparkline=false&price_change_percentage=24h" +
    "&include_24hr_vol=true";
  return await fetchJson(url);
}

// BTC snapshot (zelfde bron)
async function getBtcSnapshot() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&sparkline=false&price_change_percentage=24h" +
    "&include_24hr_vol=true";
  const arr = await fetchJson(url);
  return arr?.[0] || null;
}

// Bitget spot symbols (USDT)
async function getBitgetUSDTSet() {
  // cache 24u
  const cached = await kv.get("cc:bitget:usdt:set");
  const cachedAt = await kv.get("cc:bitget:usdt:set:ts");
  if (cached && cachedAt && Date.now() - cachedAt < 24 * 60 * 60 * 1000) {
    return new Set(cached);
  }

  const url = "https://api.bitget.com/api/v2/spot/public/symbols";
  const j = await fetchJson(url);
  const list = j?.data || [];
  const symbols = [];

  for (const s of list) {
    // verwacht bijv: baseCoin / quoteCoin
    const base = (s.baseCoin || "").toUpperCase();
    const quote = (s.quoteCoin || "").toUpperCase();
    if (!base || quote !== "USDT") continue;
    symbols.push(base);
  }

  await kv.set("cc:bitget:usdt:set", symbols);
  await kv.set("cc:bitget:usdt:set:ts", Date.now());
  return new Set(symbols);
}

// ============================
// BTC gate (bull/bear/neutral)
// ============================
function btcGate(btc) {
  if (!btc) return { state: "NEUTRAL", reason: "no btc" };

  const chg = Number(btc.price_change_percentage_24h) || 0;
  const high = Number(btc.high_24h) || 0;
  const low = Number(btc.low_24h) || 0;
  const mid = Number(btc.current_price) || 0;
  const range24 = mid > 0 ? ((high - low) / mid) * 100 : 0;

  const bull =
    chg > DEFAULTS.btcChangeGate &&
    range24 >= DEFAULTS.btcBullRangeMin &&
    range24 <= DEFAULTS.btcBullRangeMax;

  const bear =
    chg < -DEFAULTS.btcChangeGate &&
    range24 >= DEFAULTS.btcBearRangeMin &&
    range24 <= DEFAULTS.btcBearRangeMax;

  const state = bull ? "BULL" : bear ? "BEAR" : "NEUTRAL";
  return { state, chg24: chg, range24 };
}

// ============================
// FILTERS
// ============================
function calcVM(vol, mcap) {
  if (!mcap || mcap <= 0) return 0;
  return vol / mcap;
}

function calcRange24(high, low, price) {
  const p = price || 0;
  if (p <= 0) return 0;
  return ((high - low) / p) * 100;
}

function passRadar(c) {
  const price = Number(c.current_price) || 0;
  const vol = Number(c.total_volume) || 0;
  const mcap = Number(c.market_cap) || 0;
  const chg = Number(c.price_change_percentage_24h) || 0;
  const range24 = calcRange24(Number(c.high_24h)||0, Number(c.low_24h)||0, price);
  const vm = calcVM(vol, mcap);

  if (mcap < DEFAULTS.mcapMin) return false;
  if (DEFAULTS.mcapMax && mcap > DEFAULTS.mcapMax) return false;
  if (vol < DEFAULTS.radarVolMin) return false;
  if (vm < DEFAULTS.radarVmMin) return false;
  if (Math.abs(chg) > DEFAULTS.absChange24Max) return false;
  if (range24 > DEFAULTS.range24Max) return false;

  return true;
}

function passBuildup(c, mode) {
  const vol = Number(c.total_volume) || 0;
  const mcap = Number(c.market_cap) || 0;
  const chg = Number(c.price_change_percentage_24h) || 0;
  const vm = calcVM(vol, mcap);

  if (vm < DEFAULTS.buildupVmMin) return false;
  if (vol < DEFAULTS.buildupVolMin) return false;

  if (mode === "bull") return chg >= DEFAULTS.buildupChangeMin;
  return chg <= -DEFAULTS.buildupChangeMin;
}

function passAlmost(c) {
  const vol = Number(c.total_volume) || 0;
  const mcap = Number(c.market_cap) || 0;
  const vm = calcVM(vol, mcap);

  if (vm < DEFAULTS.almostVmMin) return false;
  if (vol < DEFAULTS.almostVolMin) return false;
  return true;
}

// ENTRY: OB wordt pas later “valid” via samples → hier alleen “voorwaarden”, OB check komt uit orderbook store
function passEntryBase(c) {
  const chg = Number(c.price_change_percentage_24h) || 0;
  const abs = Math.abs(chg);
  if (abs < DEFAULTS.entryChangeMin) return false;
  if (abs > DEFAULTS.lateMoveMax) return false;
  return true;
}

// ============================
// STAGE MACHINE (Reset = epoch)
// ============================
function coinKey(mode, sym) {
  return `cc:${mode}:coin:${sym}`;
}

function keysListKey(mode) {
  return `cc:${mode}:keys`;
}

function epochKey(mode) {
  return `cc:${mode}:epoch`;
}

async function getEpoch(mode) {
  const e = await kv.get(epochKey(mode));
  if (e) return e;
  const now = Date.now();
  await kv.set(epochKey(mode), now);
  return now;
}

function nextStage(current, want) {
  // alleen vooruit in vaste volgorde
  const order = ["RADAR", "BUILDUP", "ALMOST", "ENTRY"];
  const ci = order.indexOf(current);
  const wi = order.indexOf(want);
  if (wi === -1) return current;
  if (wi <= ci) return current;
  return want;
}

async function notifyIfStageEntered(mode, sym, coin, prevStage, newStage) {
  if (newStage === prevStage) return;

  const webhook = stageWebhook(newStage);
  if (!webhook) return;

  const title = `${mode.toUpperCase()} • ${newStage} • ${sym}`;
  const chg = Number(coin.price_change_percentage_24h) || 0;
  const vol = Number(coin.total_volume) || 0;
  const mcap = Number(coin.market_cap) || 0;
  const vm = calcVM(vol, mcap);

  await sendDiscord(webhook, {
    username: "CryptoCroc Scanner",
    embeds: [
      {
        title,
        description:
          `Prijs: $${Number(coin.current_price || 0).toFixed(6)}\n` +
          `Change24: ${pct(chg)}\n` +
          `Volume: ${fmtUsd(vol)} • MC: ${fmtUsd(mcap)}\n` +
          `VM: ${vm.toFixed(2)}\n`,
      },
    ],
  });
}

// ============================
// MAIN HANDLER
// ============================
export default async function handler(req, res) {
  try {
    // scan endpoint wil je NIET handmatig gebruiken → alleen cron
    // Maar als jij hem toch open wilt zetten: haal dit weg.
    if (!requireCron(req)) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const mode = (url.searchParams.get("mode") || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "mode must be bull or bear" }));
      return;
    }

    const epoch = await getEpoch(mode);

    const [btc, markets, bitgetSet] = await Promise.all([
      getBtcSnapshot(),
      getMarkets(),
      getBitgetUSDTSet(),
    ]);

    const btcInfo = btcGate(btc);

    // BTC gate: als NEUTRAL → leeg output (en géén stage updates)
    if (btcInfo.state === "NEUTRAL" || (mode === "bull" && btcInfo.state !== "BULL") || (mode === "bear" && btcInfo.state !== "BEAR")) {
      const out = {
        ok: true,
        ts: Date.now(),
        epoch,
        mode,
        btc: btcInfo,
        counts: { entry: 0, almost: 0, buildup: 0, radar: 0 },
        funnel: { entry: [], almost: [], buildup: [], radar: [] },
        note: "BTC gate OFF → geen scan updates",
      };

      await kv.set(`cc:${mode}:latest`, out);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
      return;
    }

    // Universe: CoinGecko + Bitget USDT
    const universe = [];
    for (const c of markets) {
      const sym = (c.symbol || "").toUpperCase();
      if (!sym) continue;
      if (!bitgetSet.has(sym)) continue;
      universe.push(c);
    }

    // RADAR candidates
    const radarCandidates = universe.filter(passRadar);

    // sort: beste bovenaan (VM hoog)
    radarCandidates.sort((a, b) => {
      const va = calcVM(Number(a.total_volume)||0, Number(a.market_cap)||0);
      const vb = calcVM(Number(b.total_volume)||0, Number(b.market_cap)||0);
      return vb - va;
    });

    const radarMax = 160;
    const radarList = radarCandidates.slice(0, radarMax);

    const funnel = { radar: [], buildup: [], almost: [], entry: [] };
    const keysKey = keysListKey(mode);
    const trackedKeys = (await kv.get(keysKey)) || [];

    // helper: load state
    const getState = async (sym) => {
      const key = coinKey(mode, sym);
      const st = await kv.get(key);
      // als epoch veranderd is → behandelen als nieuw
      if (!st || st.epoch !== epoch) {
        return {
          epoch,
          symbol: sym,
          stage: "RADAR",
          stageScans: 0,     // hoeveel scans in huidige stage
          lastStage: "RADAR",
          lastSeenTs: 0,
        };
      }
      return st;
    };

    // helper: save state + ensure key tracking
    const putState = async (sym, st) => {
      const key = coinKey(mode, sym);
      await kv.set(key, st);

      // track keys zodat reset ze kan wissen
      if (!trackedKeys.includes(key)) trackedKeys.push(key);
    };

    // stage machine loop
    for (const c of radarList) {
      const sym = (c.symbol || "").toUpperCase();
      const st = await getState(sym);

      // bepaal “wens stage” op basis van filters
      const wantRadar = passRadar(c);
      if (!wantRadar) continue;

      let want = "RADAR";
      if (passBuildup(c, mode)) want = "BUILDUP";
      if (passAlmost(c)) want = "ALMOST";

      // ENTRY base voorwaarden (OB gate komt later via samples; voorlopig alleen base)
      if (passEntryBase(c)) want = nextStage(want, "ENTRY");

      // >>> HIER is de fix voor “reset maar meteen Almost”:
      // Je mag pas door als je minimaal X scans in de vorige stage hebt gezeten.
      // Dus: na reset staat stageScans = 0 en start in RADAR.

      let newStage = st.stage;

      // altijd eerst “stageScans” ophogen voor de huidige stage als coin nog bestaat
      const now = Date.now();

      // als coin in hetzelfde stadium blijft, tel 1 scan op
      // als coin naar hoger stadium “wil”, alleen toestaan als st.stageScans >= minScansPerStage
      if (want === st.stage) {
        newStage = st.stage;
      } else {
        // coin wil hoger
        const canAdvance = st.stageScans >= DEFAULTS.minScansPerStage;
        if (canAdvance) {
          newStage = nextStage(st.stage, want);
        } else {
          // nog niet genoeg scans → blijf in huidige stage (meestal RADAR na reset)
          newStage = st.stage;
        }
      }

      // update stageScans
      let stageScans = st.stageScans;
      if (newStage === st.stage) {
        stageScans = stageScans + 1;
      } else {
        stageScans = 1; // eerste scan in nieuwe stage
      }

      const prevStage = st.stage;

      const nextState = {
        ...st,
        epoch,
        stage: newStage,
        stageScans,
        lastSeenTs: now,
      };

      await putState(sym, nextState);

      // Discord notification bij stage-enter
      await notifyIfStageEntered(mode, sym, c, prevStage, newStage);

      // output funnel
      const item = {
        symbol: sym,
        price: Number(c.current_price) || 0,
        volume: Number(c.total_volume) || 0,
        marketCap: Number(c.market_cap) || 0,
        change24: Number(c.price_change_percentage_24h) || 0,
        range24: calcRange24(Number(c.high_24h)||0, Number(c.low_24h)||0, Number(c.current_price)||0),
        vm: calcVM(Number(c.total_volume)||0, Number(c.market_cap)||0),
        stage: newStage,
        stageScans,
      };

      if (newStage === "RADAR") funnel.radar.push(item);
      if (newStage === "BUILDUP") funnel.buildup.push(item);
      if (newStage === "ALMOST") funnel.almost.push(item);
      if (newStage === "ENTRY") funnel.entry.push(item);
    }

    await kv.set(keysKey, trackedKeys);

    const out = {
      ok: true,
      ts: Date.now(),
      epoch,
      mode,
      btc: btcInfo,
      counts: {
        entry: funnel.entry.length,
        almost: funnel.almost.length,
        buildup: funnel.buildup.length,
        radar: funnel.radar.length,
      },
      funnel,
    };

    await kv.set(`cc:${mode}:latest`, out);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}