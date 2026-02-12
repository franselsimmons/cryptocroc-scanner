import { rangePct, vmRatio, ctlProxy } from "./utils.js";

export const STAGES = ["RADAR", "BUILDUP", "ALMOST", "ENTRY"];
export const stageIndex = (s) => Math.max(0, STAGES.indexOf(s || "RADAR"));

export function moveOneStep(cur, desired) {
  const ci = stageIndex(cur);
  const di = stageIndex(desired);
  if (di > ci) return STAGES[ci + 1] || cur;
  if (di < ci) return STAGES[Math.max(0, ci - 1)] || cur;
  return cur;
}

export function initMem(symbol) {
  return {
    symbol,
    stage: "RADAR",
    totalScans: 0,
    scansInStage: 0,
    hist: [], // last 12
    lastExplain: ""
  };
}

export function normalizeMem(mem, symbol) {
  if (!mem || typeof mem !== "object") mem = {};
  if (!mem.symbol) mem.symbol = symbol;
  if (!mem.stage) mem.stage = "RADAR";
  if (!Number.isFinite(mem.totalScans)) mem.totalScans = 0;
  if (!Number.isFinite(mem.scansInStage)) mem.scansInStage = 0;
  if (!Array.isArray(mem.hist)) mem.hist = [];
  if (typeof mem.lastExplain !== "string") mem.lastExplain = "";
  return mem;
}

export function pushHist(mem, row) {
  mem.hist.push(row);
  if (mem.hist.length > 12) mem.hist.shift();
}

export function calcConsistency(mem) {
  const last = mem.hist.slice(-6);
  if (!last.length) return 0;
  return last.filter(x => x.passSide === true).length / last.length;
}

export function calcVolAcceleration(mem) {
  const h = mem.hist.slice(-6);
  if (h.length < 6) return 0;
  const a = h.slice(0, 3).reduce((s, x) => s + (x.vol || 0), 0) / 3;
  const b = h.slice(3, 6).reduce((s, x) => s + (x.vol || 0), 0) / 3;
  if (a <= 0) return 0;
  return (b - a) / a;
}

export function calcPriceFlat(mem) {
  const p = mem.hist.slice(-6).map(x => x.price).filter(v => Number.isFinite(v));
  if (p.length < 3) return null;
  const mn = Math.min(...p), mx = Math.max(...p);
  if (mn <= 0) return null;
  return ((mx - mn) / mn) * 100;
}

export function decideSideByBands(ch24, bullBand, bearBand) {
  const bullOk = (ch24 >= bullBand.min && ch24 <= bullBand.max);
  const bearOk = (ch24 >= bearBand.min && ch24 <= bearBand.max);

  if (bullOk && !bearOk) return "BULL";
  if (!bullOk && bearOk) return "BEAR";
  if (bullOk && bearOk) return ch24 >= 0 ? "BULL" : "BEAR"; // overlap tie-break
  return null;
}

export function timingScore(side, c, vmBuildMin = 0.14) {
  let s = 0;
  if (side === "BULL") {
    if (c.ch24 > 0) s++;
    if (c.vm >= vmBuildMin) s++;
    if (c.range != null && c.range >= 4.2 && c.range <= 25) s++;
    if (c.ctl != null && c.ctl >= 0.70) s++;
  } else {
    if (c.ch24 < 0) s++;
    if (c.vm >= vmBuildMin) s++;
    if (c.range != null && c.range >= 4.2 && c.range <= 25) s++;
    if (c.ctl != null && c.ctl <= 0.30) s++;
  }
  return s;
}

export function enrichCoin(raw) {
  const c = { ...raw };
  c.range = rangePct(c.high, c.low);
  c.vm = vmRatio(c.vol, c.mcap);
  c.ctl = ctlProxy(c.price, c.high, c.low);
  return c;
}

export function entryStateFromOB(side, ob, cfgOB) {
  if (!ob || ob.spreadPct == null) return "ENTRY";
  const { spreadPct, score } = ob;

  if (side === "BULL") {
    if (score <= cfgOB.bullSellScore && spreadPct >= cfgOB.sellSpreadPct) return "SELL";
    if (score >= cfgOB.bullHoldScore && spreadPct <= cfgOB.holdSpreadPct) return "HOLD";
    return "ENTRY";
  } else {
    if (score >= cfgOB.bearSellScore && spreadPct >= cfgOB.sellSpreadPct) return "SELL";
    if (score <= cfgOB.bearHoldScore && spreadPct <= cfgOB.holdSpreadPct) return "HOLD";
    return "ENTRY";
  }
}
