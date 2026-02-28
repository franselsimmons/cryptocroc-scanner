// /api/_portfolio_core.js
import { kv } from "@vercel/kv";

export const keyPortfolioState = "portfolio:state:v1";

export async function loadPortfolioState() {
  const s = (await kv.get(keyPortfolioState)) || null;
  if (s && typeof s === "object") {
    return {
      openByKey: s.openByKey && typeof s.openByKey === "object" ? s.openByKey : {},
      closed: Array.isArray(s.closed) ? s.closed : [],
      ts: Number(s.ts || 0) || 0,
    };
  }
  return { openByKey: {}, closed: [], ts: 0 };
}

export async function savePortfolioState(state) {
  await kv.set(keyPortfolioState, state);
}