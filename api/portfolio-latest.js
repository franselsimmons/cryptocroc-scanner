// /api/portfolio-latest.js
import { loadPortfolioState } from "./_portfolio_core.js";

export const config = { runtime: "nodejs20.x" };

export default async function handler(req, res) {
  try {
    const state = await loadPortfolioState();

    const open = Object.values(state.openByKey || {}).sort((a, b) => (b.tsOpen - a.tsOpen));
    const closed = (state.closed || []).slice(0, 250);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      ts: Date.now(),
      open,
      closed
    }));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e) }));
  }
}