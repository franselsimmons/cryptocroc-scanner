export function computeMoonRisk({
  mode,
  price,
  range24,
  confidence,
  depthOk,
  tier,
  regime = "TREND",
  persistenceScore = 50,
  drawdown = 0, // ✅ nieuw
}) {
  if (!price || price <= 0) return null;

  const p = n(price, 0);
  const r24 = clamp(n(range24, 0), 1, 45);
  const conf = clamp(n(confidence, 0), 0, 100);
  const persist = clamp(n(persistenceScore, 50), 0, 100);
  const dd = clamp(n(drawdown, 0), 0, 100);
  const reg = String(regime || "").toUpperCase();

  let slPct = clamp(3.8 + r24 * 0.11, 4.2, 8.5);
  let tpPct = clamp(10.5 + r24 * 0.38, 12, 28);

  if (conf >= 75) tpPct += 2.0;
  if (conf >= 85) tpPct += 1.5;
  if (persist >= 70) tpPct += 1.5;
  if (persist >= 80) slPct -= 0.4;

  if (!depthOk) slPct += 0.6;

  if (tier?.name === "small") {
    tpPct += 1.4;
    slPct += 0.5;
  }
  if (tier?.name === "large") {
    tpPct -= 1.2;
    slPct -= 0.4;
  }

  if (reg === "EXPANSION") tpPct += 1.8;
  if (reg === "DRY") tpPct -= 1.2;
  if (reg === "HEADWIND") {
    tpPct -= 1.6;
    slPct += 0.4;
  }

  // ✅ Adaptive exit bij slechte performance (confidence proxy)
  if (conf < 55) tpPct -= 2.5;
  if (conf < 45) tpPct -= 3.5;

  // ✅ SL strakker bij hoge drawdown
  if (dd > 40) slPct -= 0.6;

  slPct = clamp(slPct, 4.0, 8.8);
  tpPct = clamp(tpPct, 11.0, 30.0);

  const sl = mode === "bull" ? p * (1 - slPct / 100) : p * (1 + slPct / 100);
  const tp3 = mode === "bull" ? p * (1 + tpPct / 100) : p * (1 - tpPct / 100);

  return { sl, tp3, slPct, tpPct };
}