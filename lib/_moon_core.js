export function computeMarketRegime({ btc, whaleFlow, mode }) {
  const btcState = btc?.state |

| "NEUTRAL";
  const chg24 = Number(btc?.chg24 |

| 0);
  const range24 = Number(btc?.range24 |

| 0);
  if (range24 >= 5.5 && Math.abs(chg24) >= 1.5) return "EXPANSION";
  if (range24 <= 1.4 && Math.abs(chg24) <= 0.45) return "DRY";
  if (range24 <= 2.7 && Math.abs(chg24) <= 0.9) return "CHOP";
  if (mode === "bull" && btcState === "BEAR") return "HEADWIND";
  if (mode === "bear" && btcState === "BULL") return "HEADWIND";
  return "TREND";
}
