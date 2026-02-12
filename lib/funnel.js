import { kv } from "./kv.js";
import { clamp, now, safeNum } from "./utils.js";
import { getOrderbook } from "./orderbook.js";

// Stages
export const STAGES = ["RADAR","BUILDUP","ALMOST","ENTRY","HOLD","SELL"];

function memKey(side, id) { return `mem:${side}:${id}`; }
function stateKey(side, id) { return `state:${side}:${id}`; }
function outKey(side) { return `out:${side}`; }
function lockKey(side) { return `lock:${side}`; }

// Config (simpel maar “echt”: stage moet meerdere scans confirm krijgen)
const REQ = {
  RADAR:   1,
  BUILDUP: 2,
  ALMOST:  2,
  ENTRY:   2,
  HOLD:    2,
  SELL:    1
};

// Filters (bull/bear verschillen)
function passForStageBull(stage, c, hist) {
  const vm = c.mcap > 0 ? (c.vol / c.mcap) : 0;
  const abs24 = Math.abs(c.ch24);

  // kleine “stabiliteit” via historie: laatste 3 ch1h niet extreem schommelen
  const h = hist.slice(-3);
  const ch1hs = h.map(x => safeNum(x.ch1h));
  const ch1hVar = ch1hs.length ? (Math.max(...ch1hs) - Math.min(...ch1hs)) : 999;

  if (stage === "RADAR")   return vm >= 0.08 && abs24 <= 25;
  if (stage === "BUILDUP") return vm >= 0.12 && c.ch24 >= -3 && c.ch24 <= 12 && ch1hVar <= 6;
  if (stage === "ALMOST")  return vm >= 0.16 && c.ch24 >= 0 && c.ch24 <= 18 && safeNum(c.ch1h) >= -1;
  if (stage === "ENTRY")   return vm >= 0.20 && c.ch24 >= 1 && c.ch24 <= 25 && safeNum(c.ch1h) >= 0;
  if (stage === "HOLD")    return c.ch24 >= 4 && vm >= 0.14;
  if (stage === "SELL")    return c.ch24 < 1 || safeNum(c.ch1h) < -1.5;
  return false;
}

function passForStageBear(stage, c, hist) {
  const vm = c.mcap > 0 ? (c.vol / c.mcap) : 0;
  const abs24 = Math.abs(c.ch24);
  const h = hist.slice(-3);
  const ch1hs = h.map(x => safeNum(x.ch1h));
  const ch1hVar = ch1hs.length ? (Math.max(...ch1hs) - Math.min(...ch1hs)) : 999;

  if (stage === "RADAR")   return vm >= 0.08 && abs24 <= 25;
  if (stage === "BUILDUP") return vm >= 0.12 && c.ch24 <= 3 && c.ch24 >= -12 && ch1hVar <= 6;
  if (stage === "ALMOST")  return vm >= 0.16 && c.ch24 <= 0 && c.ch24 >= -18 && safeNum(c.ch1h) <= 1;
  if (stage === "ENTRY")   return vm >= 0.20 && c.ch24 <= -1 && c.ch24 >= -25 && safeNum(c.ch1h) <= 0;
  if (stage === "HOLD")    return c.ch24 <= -4 && vm >= 0.14;
  if (stage === "SELL")    return c.ch24 > -1 || safeNum(c.ch1h) > 1.5;
  return false;
}

function stageIndex(s) { return STAGES.indexOf(s); }
function promote(stage) { return STAGES[clamp(stageIndex(stage)+1, 0, STAGES.length-1)]; }
function demote(stage) { return STAGES[clamp(stageIndex(stage)-1, 0, STAGES.length-1)]; }

async function loadHist(side, id) {
  const k = memKey(side, id);
  const arr = (await kv.get(k)) || [];
  return Array.isArray(arr) ? arr : [];
}

async function saveHist(side, id, hist) {
  const k = memKey(side, id);
  const last = hist.slice(-12);
  await kv.set(k, last);
  return last;
}

async function loadState(side, id) {
  const s = await kv.get(stateKey(side, id));
  if (s && typeof s === "object") return s;
  return { stage: "RADAR", passCount: 0, failCount: 0 };
}

async function saveState(side, id, st) {
  await kv.set(stateKey(side, id), st);
}

export async function tryLock(side) {
  const lk = lockKey(side);
  const existing = await kv.get(lk);
  if (existing) return false;
  await kv.set(lk, "1", { ex: 25 });
  return true;
}

export async function unlock(side) {
  await kv.del(lockKey(side));
}

export async function runFunnel(side, coins) {
  const isBull = side === "bull";
  const tables = {
    RADAR: [], BUILDUP: [], ALMOST: [], ENTRY: [], HOLD: [], SELL: []
  };

  // beperk zodat Vercel niet explodeert:
  // coins: neem top 250 maar filter op “heeft volume + mcap”
  const candidates = coins
    .filter(c => c.mcap > 0 && c.vol > 0)
    .slice(0, 250);

  // Eerst stage/memory bepalen (zonder orderbook)
  const decided = [];
  for (const c of candidates) {
    const hist = await loadHist(side, c.id);
    const nextHist = await saveHist(side, c.id, [...hist, { t: now(), ch1h: c.ch1h, ch24: c.ch24, vol: c.vol, mcap: c.mcap }]);
    const st = await loadState(side, c.id);

    const passFn = isBull ? passForStageBull : passForStageBear;
    const passes = passFn(st.stage, c, nextHist);

    let stage = st.stage;
    let passCount = st.passCount;
    let failCount = st.failCount;

    if (passes) {
      passCount += 1;
      failCount = 0;
      if (passCount >= (REQ[stage] || 2)) {
        // promotie behalve als al SELL
        if (stage !== "SELL") {
          stage = promote(stage);
          passCount = 0;
          failCount = 0;
        }
      }
    } else {
      failCount += 1;
      passCount = 0;
      // na 2 fails demote
      if (failCount >= 2) {
        stage = demote(stage);
        failCount = 0;
      }
    }

    const vm = c.mcap > 0 ? (c.vol / c.mcap) : 0;

    const row = {
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      price: c.price,
      ch1h: c.ch1h,
      ch24: c.ch24,
      ch7d: c.ch7d,
      vm: Number(vm.toFixed(4)),
      stage,
      mem: { passCount, failCount }
    };

    await saveState(side, c.id, { stage, passCount, failCount });

    decided.push(row);
  }

  // Orderbook alleen vanaf ALMOST/ENTRY/HOLD/SELL → max 12 calls (Vercel safe)
  const needOB = decided
    .filter(x => ["ALMOST","ENTRY","HOLD","SELL"].includes(x.stage))
    .sort((a,b) => (b.vm - a.vm))
    .slice(0, 12);

  const obMap = new Map();
  for (const x of needOB) {
    const symbolUSDT = (String(x.symbol || "").toUpperCase().replace(/[^A-Z0-9]/g,"")) + "USDT";
    const ob = await getOrderbook(symbolUSDT);
    if (ob?.score) {
      obMap.set(x.id, {
        src: ob.src,
        imbalance: Number(ob.score.imbalance.toFixed(4)),
        spread: ob.score.spread === null ? null : Number(ob.score.spread.toFixed(6))
      });
    } else {
      obMap.set(x.id, null);
    }
  }

  // Tables vullen + OB injecten
  for (const x of decided) {
    x.ob = obMap.has(x.id) ? obMap.get(x.id) : undefined;
    tables[x.stage].push(x);
  }

  // sorteer per table op vm
  for (const k of Object.keys(tables)) {
    tables[k].sort((a,b) => (b.vm - a.vm));
  }

  const out = { side, t: now(), tables };
  await kv.set(outKey(side), out);
  return out;
}

export async function getOutput(side) {
  return (await kv.get(outKey(side))) || { side, t: now(), tables: { RADAR:[], BUILDUP:[], ALMOST:[], ENTRY:[], HOLD:[], SELL:[] } };
}
