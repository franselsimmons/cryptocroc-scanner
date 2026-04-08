function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

/**
 * Lokale TP/SL checker zodat de trade engine volledig zelfstandig is.
 */
export function hitStopOrTpLocal({ side, price, entry, sl, tp }) {
  const s = up(side);
  const p = n(price, 0);
  const e = n(entry, 0);
  const stop = n(sl, 0);
  const take = n(tp, 0);

  if (!(p > 0) || !(e > 0)) return null;

  if (s === "SHORT") {
    if (stop > 0 && p >= stop) return { hit: "SL" };
    if (take > 0 && p <= take) return { hit: "TP" };
    return null;
  }

  if (stop > 0 && p <= stop) return { hit: "SL" };
  if (take > 0 && p >= take) return { hit: "TP" };
  return null;
}

/**
 * Eenvoudige entry-trigger voor funnel WATCH -> ENTRY.
 * Dit is bewust tunnel-logica, niet scanner-logica.
 */
export function entryTriggerOk({
  side,
  price,
  entry,
  spreadPct,
  maxSpreadPct,
  obScore,
  minObScoreAbs = 0,
  breakout,
  requireBreakout = false,
  minBreakoutPressure = 0,
  maxEntryDistancePct = 1.25,
}) {
  const s = up(side);
  const p = n(price, 0);
  const e = n(entry, 0);
  const sp = n(spreadPct, 999);
  const obs = n(obScore, 0);

  if (!(p > 0) || !(e > 0)) return false;
  if (sp > n(maxSpreadPct, 999)) return false;

  const breakoutReady = !!breakout?.ready;
  const breakoutPressure = n(breakout?.pressure, 0);
  const breakoutOk = breakoutReady || breakoutPressure >= n(minBreakoutPressure, 0);

  if (requireBreakout && !breakoutOk) return false;

  const distPct = Math.abs((p - e) / e) * 100;
  if (distPct > n(maxEntryDistancePct, 999)) return false;

  if (n(minObScoreAbs, 0) > 0) {
    if (s === "SHORT") {
      if (obs > -Math.abs(minObScoreAbs)) return false;
    } else {
      if (obs < Math.abs(minObScoreAbs)) return false;
    }
  }

  return true;
}

/**
 * Hard break / echte sell-conditie.
 */
export function hardBreakDetected({
  side,
  obScore,
  obContraExtremeAbs,
  spreadPct,
  maxSpreadPctInTrade,
}) {
  const s = up(side);
  const obs = n(obScore, 0);
  const spread = n(spreadPct, 999);
  const extreme = Math.abs(n(obContraExtremeAbs, 0));

  if (spread > n(maxSpreadPctInTrade, 999)) {
    return { hit: true, reason: "spread_spike" };
  }

  if (s === "SHORT") {
    if (obs >= extreme) return { hit: true, reason: "hard_break" };
  } else {
    if (obs <= -extreme) return { hit: true, reason: "hard_break" };
  }

  return { hit: false, reason: "" };
}

export default {
  hitStopOrTpLocal,
  entryTriggerOk,
  hardBreakDetected,
};