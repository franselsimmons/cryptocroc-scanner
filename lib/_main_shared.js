import { kv } from "@vercel/kv";

export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

export async function fetchBTCGateFromUniverse() {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=bitcoin&price_change_percentage=1h,24h`;
    const arr = await fetchJsonWithTimeout(url, {}, 8000);
    const btc = arr;
    return {
      price: Number(btc.current_price || 0),
      chg24: Number(btc.price_change_percentage_24h || 0),
      chg1h: Number(btc.price_change_percentage_1h || 0),
      range24: btc.high_24h && btc.low_24h? ((btc.high_24h - btc.low_24h) / btc.low_24h) * 100 : 0,
    };
  } catch {
    return { price: 0, chg24: 0, chg1h: 0, range24: 0 };
  }
}

export async function fetchCoinGeckoTopCached(maxCoins = 300) {
  try {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&price_change_percentage=1h,24h`;
    const rows = await fetchJsonWithTimeout(url, {}, 9000);
    await kv.set("cache:cg_top", rows, { ex: 600 });
    return rows;
  } catch {
    const cached = await kv.get("cache:cg_top");
    return Array.isArray(cached)? cached :;
  }
}

export async function fetchContractConfigs() {
  try {
    const url = "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES";
    const res = await fetchJsonWithTimeout(url, {}, 5000);
    const map = new Map();
    if (res?.data) res.data.forEach(c => map.set(c.symbol, c));
    return map;
  } catch {
    return new Map();
  }
}

export async function fetchFuturesTickers() {
  try {
    const url = "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";
    const res = await fetchJsonWithTimeout(url, {}, 5000);
    const map = new Map();
    if (res?.data) res.data.forEach(t => map.set(t.symbol, t));
    return map;
  } catch {
    return new Map();
  }
}

export function generateShallowOb(ticker) {
  const ask = parseFloat(ticker?.bestAsk || 0);
  const bid = parseFloat(ticker?.bestBid || 0);
  const spreadPct = (ask > 0 && bid > 0)? ((ask - bid) / bid) * 100 : 999;
  return { bestAsk: ask, bestBid: bid, spreadPct, depthMinUsd1p: 0, score: 0, valid: ask > 0 && bid > 0, fresh: true, stale: false, reason: "shallow" };
}

export function calculateFuturesSize(entryPrice, slPrice, maxRiskUsd, contractConfig) {
  if (!entryPrice ||!slPrice || entryPrice === slPrice) return 0;
  const riskPerCoin = Math.abs(entryPrice - slPrice);
  const rawSize = maxRiskUsd / riskPerCoin;
  const sizeMultiplier = parseFloat(contractConfig?.sizeMultiplier || 0.01);
  const volumePlace = parseInt(contractConfig?.volumePlace || 2);
  const steps = Math.floor(rawSize / sizeMultiplier);
  return Number((steps * sizeMultiplier).toFixed(volumePlace));
}
