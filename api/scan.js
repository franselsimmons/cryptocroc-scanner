// api/scan.js
import { kv } from "@vercel/kv";

import {
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
} from "../lib/_moon_core.js";

import {
  generateShallowOb,
  calculateFuturesSize,
  preScoreMainCoin,
} from "../lib/_scanner_helpers.js";

import MAIN_CORE_BULL from "../lib/_core_bull.js";
import MAIN_CORE_BEAR from "../lib/_core_bear.js";

const BITGET_FUTURES_TICKERS =
  "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES";

const BITGET_FUTURES_CONTRACTS =
  "https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default async function scannerHandler(req, res) {
  const mode =
    String(req.query?.mode || "bull").toLowerCase() === "bear"
      ? "bear"
      : "bull";

  const now = Date.now();

  try {
    const MAIN_CORE = mode === "bull" ? MAIN_CORE_BULL : MAIN_CORE_BEAR;

    const [btc, cg, tickersRes, contractsRes] = await Promise.all([
      fetchBTCGateFromUniverse(),
      fetchCoinGeckoTopCached(300),
      fetchJson(BITGET_FUTURES_TICKERS),
      fetchJson(BITGET_FUTURES_CONTRACTS),
    ]);

    const tickers = Array.isArray(tickersRes?.data)
      ? tickersRes.data
      : [];

    const contracts = Array.isArray(contractsRes?.data)
      ? contractsRes.data
      : [];

    const validFutures = new Map(
      tickers.map((t) => [t.symbol, t])
    );

    const contractConfigs = new Map(
      contracts.map((c) => [c.symbol, c])
    );

    const coins = Array.isArray(cg?.coins) ? cg.coins : [];

    const tradable = coins.filter((c) =>
      validFutures.has(`${c.symbol.toUpperCase()}USDT`)
    );

    const funnelQueue = [];
    const eventQueue = [];

    for (const coin of tradable) {
      const sym = String(coin.symbol || "").toUpperCase();
      if (!sym) continue;

      const symbolUsdt = `${sym}USDT`;

      const ticker = validFutures.get(symbolUsdt);
      const config = contractConfigs.get(symbolUsdt);

      if (!ticker || !config) continue;

      const obx = generateShallowOb(ticker);

      if (!obx || obx.spreadPct > 2.5) continue;

      // ===== MAIN SCORING =====
      const mainScore = preScoreMainCoin(coin, mode, MAIN_CORE);

      if (
        mainScore.stage === "ENTRY_READY" ||
        mainScore.stage === "SETUP"
      ) {
        const entry = Number(coin.price || 0);
        if (!(entry > 0)) continue;

        const tradePlan = {
          entry,
          sl: entry * (mode === "bull" ? 0.95 : 1.05),
          tp: entry * (mode === "bull" ? 1.1 : 0.9),
        };

        tradePlan.size = calculateFuturesSize(
          tradePlan.entry,
          tradePlan.sl,
          50,
          config
        );

        funnelQueue.push({
          symbol: sym,
          side: mode === "bull" ? "LONG" : "SHORT",
          sourceSystem: "main",
          sourceMode: mode,
          stage: mainScore.stage,
          confidence: mainScore.confidence,
          tradePlan,
          queuedAt: now,
          lifecycleState: "NEW",
        });
      }
    }

    // ===== KV WRITE =====
    if (funnelQueue.length > 0) {
      await kv.lpush(
        `trade_funnel:raw_queue:${mode}`,
        ...funnelQueue.map((x) => JSON.stringify(x))
      );
    }

    // ===== EVENTS =====
    if (eventQueue.length > 0) {
      const multi = kv.multi();
      let nonce = 0;

      for (const ev of eventQueue) {
        const score =
          ev.priority * 1e13 +
          now * 1000 +
          (nonce++ % 1000);

        multi.zadd("system:events:queue", {
          score,
          member: JSON.stringify(ev),
        });
      }

      await multi.exec();
    }

    return res.status(200).json({
      ok: true,
      forwarded: funnelQueue.length,
      mode,
    });
  } catch (err) {
    console.error("Scan error:", err);

    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}