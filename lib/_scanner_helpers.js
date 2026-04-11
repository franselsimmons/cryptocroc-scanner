// lib/_scanner_helpers.js

export function generateShallowOb(ticker) {
  const ask = parseFloat(ticker?.bestAsk |

| 0);
  const bid = parseFloat(ticker?.bestBid |

| 0);
  const spreadPct = (ask > 0 && bid > 0)? ((ask - bid) / bid) * 100 : 999;
  
  return {
    bestAsk: ask,
    bestBid: bid,
    spreadPct: spreadPct,
    depthMinUsd1p: 0, 
    score: 0,         
    valid: ask > 0 && bid > 0,
    fresh: true,
    stale: false,
    reason: "shallow_ticker_only"
  };
}

export function calculateFuturesSize(entryPrice, slPrice, maxRiskUsd, contractConfig) {
  if (!entryPrice ||!slPrice |

| entryPrice === slPrice) return 0;
  
  const riskPerCoin = Math.abs(entryPrice - slPrice);
  const rawSize = maxRiskUsd / riskPerCoin;
  
  // Gebruik de actuele Bitget contract specificaties
  const sizeMultiplier = parseFloat(contractConfig?.sizeMultiplier |

| 0.01);
  const volumePlace = parseInt(contractConfig?.volumePlace |

| 2);
  
  const steps = Math.floor(rawSize / sizeMultiplier);
  const normalizedSize = steps * sizeMultiplier;
  
  return Number(normalizedSize.toFixed(volumePlace));
}

// Minimalistische adapter voor Main pre-scoring
export function preScoreMainCoin(coin, mode, CORE) {
  const marketCap = Number(coin.marketCap |

| 0);
  const volume = Number(coin.volume |

| 0);
  const change24 = Number(coin.change24 |

| 0);
  const range24 = Number(coin.range24 |

| 0);
  const vm = CORE.computeVm(volume, marketCap);
  
  const confidence = CORE.computeConfidence({ vm, change24, range24, obValid: false });
  const isSetup = confidence >= 30 && volume > 100000;
  
  return {
    stage: isSetup? "ENTRY_READY" : "RADAR",
    confidence: confidence,
    entryQuality: confidence * 0.9,
    persistenceScore: 50
  };
}
