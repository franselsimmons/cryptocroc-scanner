export const SETTINGS = {
  radar: { mcapMin: 4000000, mcapMax: 3000000000, volMin: 120000, vmMin: 0.01 },
  buildup: { minVolAcc: 0.78 },
  almost: { minConfidence: 8, maxFlat60Pct: 44.0 }
};

export function getCfg() { return SETTINGS; }

export function computeVm(volume, marketCap) {
  const v = Number(volume |

| 0); const m = Number(marketCap |
| 0);
  return v > 0 && m > 0? v / m : 0;
}

export function computeConfidence({ vm, change24, range24, obValid }) {
  let c = 0;
  c += Math.max(0, Math.min(40, (Number(vm||0) / 0.26) * 40));
  c += Math.max(0, Math.min(22, (Math.abs(Number(change24||0)) / 12) * 22));
  c += Math.max(0, 18 - Math.min(18, Number(range24||0) / 3.5));
  if (obValid) c += 10;
  return Math.max(0, Math.min(100, Math.round(c)));
}

export function computeBtcState(btc, settings) {
  const chg24 = Number(btc?.chg24 |

| 0);
  if (chg24 >= 0.9) return "BULL";
  if (chg24 <= -0.45) return "BEAR";
  return "NEUTRAL";
}

export function preScoreCoin(coin, mode) {
  const marketCap = Number(coin.market_cap |

| 0);
  const volume = Number(coin.total_volume |

| 0);
  const change24 = Number(coin.price_change_percentage_24h |

| 0);
  const range24 = coin.high_24h && coin.low_24h? ((coin.high_24h - coin.low_24h) / coin.low_24h) * 100 : 0;
  
  const vm = computeVm(volume, marketCap);
  const confidence = computeConfidence({ vm, change24, range24, obValid: false });
  const isSetup = confidence >= 25 && volume > 200000;
  
  return { stage: isSetup? "ENTRY_READY" : "RADAR", confidence: confidence, entryQuality: confidence * 0.9, persistenceScore: 50 };
}
