/* EOF: /api/universe.js */
import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

// helpers
async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  const t = await r.text();
  let j = null;
  try { j = JSON.parse(t); } catch {}
  if (!r.ok) throw new Error(`Fetch failed ${r.status}: ${t.slice(0, 160)}`);
  return j;
}
function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}

// --- CoinGecko fetches (1x per cron) ---
async function fetchBtc() {
  const url =
    "https://api.coingecko.com/api/v3/coins/markets" +
    "?vs_currency=usd&ids=bitcoin&order=market_cap_desc&per_page=1&page=1" +
    "&sparkline=false&price_change_percentage=1h,24h";

  const arr = await fetchJson(url);
  const b = arr?.[0] || {};

  const chg1h = n(
    b?.price_change_percentage_1h_in_currency ?? b?.price_change_percentage_1h ?? 0,
    0
  );
  const chg24 = n(
    b?.price_change_percentage_24h_in_currency ?? b?.price_change_percentage_24h ?? 0,
    0
  );

  const high = n(b?.high_24h, 0);
  const low = n(b?.low_24h, 0);
  const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

  return { chg1h: +chg1h.toFixed(3), chg24: +chg24.toFixed(3), range24: +range24.toFixed(3) };
}

async function fetchTop(limit) {
  const per = Math.min(250, Math.max(50, Number(limit || 250)));
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc` +
    `&per_page=${per}&page=1&sparkline=false&price_change_percentage=1h,24h`;

  const arr = await fetchJson(url);

  return (arr || []).map((c) => {
    const price = n(c?.current_price, 0);
    const high = n(c?.high_24h, 0);
    const low = n(c?.low_24h, 0);
    const range24 = low > 0 ? ((high - low) / low) * 100 : 0;

    const change24 = n(
      c?.price_change_percentage_24h_in_currency ?? c?.price_change_percentage_24h ?? 0,
      0
    );
    const change1h = n(
      c?.price_change_percentage_1h_in_currency ?? c?.price_change_percentage_1h ?? 0,
      0
    );

    return {
      id: c?.id,
      symbol: up(c?.symbol),
      name: c?.name,
      price,
      volume: n(c?.total_volume, 0),
      marketCap: n(c?.market_cap, 0),
      change24,
      change1h,
      range24,
    };
  });
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const limit = Number(req?.query?.limit || 250);
    const now = Date.now();

    const btc = await fetchBtc();
    const coins = await fetchTop(limit);

    const payload = { ts: now, btc, coins, limit: Math.min(250, Math.max(50, limit)) };

    await kv.set("universe:latest", payload);

    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: true, ts: now, coins: coins.length }));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}