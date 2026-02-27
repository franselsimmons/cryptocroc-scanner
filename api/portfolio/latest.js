// api/portfolio/latest.js
import { loadPortfolioState } from "../../lib/_portfolio_core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res) {
  try {
    const state = await loadPortfolioState();

    const open = Object.values(state.openByKey || {}).sort(
      (a, b) => (Number(b.openedAt || 0) - Number(a.openedAt || 0))
    );

    const closed = (Array.isArray(state.closed) ? state.closed : [])
      .slice()
      .sort((a, b) => (Number(b.closedAt || 0) - Number(a.closedAt || 0)))
      .slice(0, 250);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: true, ts: Date.now(), open, closed }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}