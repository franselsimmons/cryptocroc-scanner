export function computeVm(vol, mcap) { return vol > 0 && mcap > 0? vol / mcap : 0; }

export function decideMoonStage({ coin, obx, btc, mode }) {
  const velocity = Math.abs(coin.change1h |

| 0) / Math.max(0.0001, Math.abs(coin.change24 |
| 0));
  const isElite = coin.change24 > 7 && obx.spreadPct < 1.1 && obx.score > 0.05 && velocity > 0.14;
  const isAlmost = coin.change24 > 4.8 && obx.spreadPct < 1.3 && obx.score > 0.02;
  
  return {
    stage: isElite? "ELITE_EXPANSION" : isAlmost? "ALMOST" : "RADAR",
    entryQuality: isElite? 80 : isAlmost? 65 : 30,
    persistenceScore: isElite? 75 : 55
  };
}

export function buildMoonTradePlan({ price, mode, confidence }) {
  return {
    entry: price,
    sl: price * 0.94,
    tp: price * 1.15,
    slPct: 6, tpPct: 15, rr: 2.5
  };
}
