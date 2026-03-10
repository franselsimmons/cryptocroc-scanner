import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

const COINGECKO = "https://api.coingecko.com/api/v3/coins/markets";
const CG_PER_PAGE = 250;
const CG_PAGES = 3;

const LOCK_KEY = "moon:lock:universe";
const UNIVERSE_KEY = "moon:universe:latest";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tryAcquireUniverseLock() {
  const now = Date.now();
  const nextBoundary = new Date(now);
  nextBoundary.setSeconds(0, 0);
  if (nextBoundary.getMinutes() < 30) {
    nextBoundary.setMinutes(30);
  } else {
    nextBoundary.setMinutes(0);
    nextBoundary.setHours(nextBoundary.getHours() + 1);
  }
  const until = nextBoundary.getTime();
  const ttlSec = Math.max(60, Math.ceil((until - now) / 1000));

  const ok = await kv.set(LOCK_KEY, { until, setAt: now }, { nx: true, ex: ttlSec });
  if (ok) return { ok: true, until };

  const cur = await kv.get(LOCK_KEY);
  if (cur?.until > now) return { ok: false, until: cur.until };
  await kv.set(LOCK_KEY, { until, setAt: now }, { ex: ttlSec });
  return { ok: true, until };
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const lock = await tryAcquireUniverseLock();
    if (!lock.ok) {
      const existing = await kv.get(UNIVERSE_KEY);
      if (existing) {
        res.status(200).json({ ok: true, ...existing, note: "universe lock active, returned cached" });
        return;
      }
      // fallback: force lock release? better wait.
      res.status(200).json({ ok: false, error: "universe lock active, no cached data" });
      return;
    }

    const allCoins = [];
    for (let page = 1; page <= CG_PAGES; page++) {
      const url = `${COINGECKO}?vs_currency=usd&order=volume_desc&per_page=${CG_PER_PAGE}&page=${page}&sparkline=false&price_change_percentage=24h,1h`;
      let ok = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await fetch(url, { headers: { accept: "application/json" } });
          if (r.ok) {
            const json = await r.json();
            if (Array.isArray(json)) allCoins.push(...json);
            ok = true;
            break;
          }
        } catch {}
        await sleep(1200);
      }
      if (!ok) break;
      await sleep(1200);
    }

    const coins = allCoins.map(c => ({
      id: c.id,
      symbol: String(c.symbol || "").toUpperCase().trim(),
      name: c.name || "",
      image: c.image || "",
      price: n(c.current_price),
      marketCap: n(c.market_cap),
      volume: n(c.total_volume),
      change24: n(c.price_change_percentage_24h),
      change1h: n(c.price_change_percentage_1h_in_currency),
      range24: (() => {
        const hi = n(c.high_24h);
        const lo = n(c.low_24h);
        return hi > 0 && lo > 0 ? ((hi - lo) / ((hi + lo) / 2)) * 100 : 0;
      })(),
    }));

    const btc = coins.find(c => c.symbol === "BTC") || {
      price: 0,
      marketCap: 0,
      volume: 0,
      change24: 0,
      change1h: 0,
      range24: 0,
    };

    const out = {
      ok: true,
      ts: Date.now(),
      count: coins.length,
      coins,
      btc,
    };

    await kv.set(UNIVERSE_KEY, out, { ex: 60 * 60 * 2 }); // 2 uur
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}