export function timingScore({ side, ch24, vm, rangePct, ctl }) {
  let s = 0;

  if (side === "BULL") {
    if (ch24 > 0) s++;
    if (vm >= 0.14) s++;
    if (rangePct >= 0.042 && rangePct <= 0.25) s++;
    if (ctl >= 0.70) s++;
  } else {
    if (ch24 < 0) s++;
    if (vm >= 0.14) s++;
    if (rangePct >= 0.042 && rangePct <= 0.25) s++;
    if (ctl <= 0.30) s++;
  }

  return s;
}

export function calcDerived(hist) {
  // hist: [{ts, price, vol, vm, passSide}]
  const last = hist.slice(-6);
  const totalScans = hist.length;

  let consistency = 0;
  if (last.length) {
    const okCount = last.filter(x => x.passSide).length;
    consistency = okCount / last.length;
  }

  // volAcc: (avg last3 - avg prev3) / avg prev3
  let volAcc = 0;
  if (last.length >= 6) {
    const prev3 = last.slice(0, 3).map(x => x.vol);
    const last3 = last.slice(3).map(x => x.vol);
    const avgPrev = prev3.reduce((a,b)=>a+b,0) / 3;
    const avgLast = last3.reduce((a,b)=>a+b,0) / 3;
    volAcc = avgPrev > 0 ? (avgLast - avgPrev) / avgPrev : 0;
  }

  // flatness: (max-min)/min over last6 prices
  let flatness = null;
  if (last.length >= 4) {
    const ps = last.map(x => x.price);
    const mn = Math.min(...ps);
    const mx = Math.max(...ps);
    flatness = mn > 0 ? (mx - mn) / mn : null;
  }

  return { totalScans, consistency, volAcc, flatness };
}

export function nextStage({ totalScans, scansInStage, consistency, volAcc, flatness, timing }) {
  // 4 stages: RADAR → BUILDUP → ALMOST → ENTRY
  // max 1 stap per scan (we bepalen stage puur op thresholds, en zetten “scansInStage” apart in mem)
  if (totalScans < 2) return "RADAR";

  // ENTRY gate
  if (
    totalScans >= 5 &&
    timing >= 3 &&
    consistency >= 0.90 &&
    volAcc >= 0.30 &&
    flatness !== null && flatness <= 0.04
  ) return "ENTRY";

  // ALMOST
  if (
    timing >= 3 &&
    consistency >= 0.85 &&
    volAcc >= 0.20 &&
    flatness !== null && flatness <= 0.04
  ) return "ALMOST";

  // BUILDUP
  if (
    timing >= 2 &&
    consistency >= 0.82 &&
    volAcc >= 0.20
  ) return "BUILDUP";

  return "RADAR";
}
