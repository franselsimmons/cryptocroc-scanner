// lib/portfolio.js

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function getPortfolio() {
  const balance = safeNumber(process.env.RUNNER_PORTFOLIO_BALANCE, 10_000);
  const maxRiskPct = safeNumber(process.env.RUNNER_MAX_RISK_PCT, 0.01);

  return {
    profile: "RUNNER",
    balance,
    risk: "controlled",
    maxRiskPct,
    maxRiskUsd: Number((balance * maxRiskPct).toFixed(2)),
    currency: "USDT",
    updatedAt: Date.now()
  };
}