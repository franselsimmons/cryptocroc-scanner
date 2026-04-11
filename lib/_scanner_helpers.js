export function generateShallowOb(ticker) {
  const ask = parseFloat(ticker?.bestAsk || 0);
  const bid = parseFloat(ticker?.bestBid || 0);

  const spreadPct = (ask && bid)
    ? ((ask - bid) / bid) * 100
    : 999;

  return {
    bestAsk: ask,
    bestBid: bid,
    spreadPct,
    depthMinUsd1p: 0,
    score: 0,
    valid: ask > 0 && bid > 0,
  };
}

export function calculateFuturesPositionSize(entry, sl, riskUsd = 50, step = 0.01) {
  if (!entry || !sl || entry === sl) return 0;

  const risk = Math.abs(entry - sl);
  const raw = riskUsd / risk;

  return Math.floor(raw / step) * step;
}

export function toFunnelCoin(coin, system, mode, now) {
  return {
    ...coin,
    sourceSystem: system,
    sourceMode: mode,
    symbol: coin.symbol.toUpperCase(),
    queuedAt: now,
    tradePlan: coin.tradePlan
      ? {
          ...coin.tradePlan,
          size: calculateFuturesPositionSize(
            coin.tradePlan.entry,
            coin.tradePlan.sl
          ),
        }
      : null,
  };
}