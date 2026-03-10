import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../../../lib/_runtime.js";
import { keyMoonObMap } from "../../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

const UNIVERSE_KEY = "moon:universe:latest";
const LOCK_KEY = "moon:lock:obmap";

async function tryAcquireLock() {
  const now = Date.now();
  const until = now + 10 * 60 * 1000; // 10 min lock
  const ok = await kv.set(LOCK_KEY, { until }, { nx: true, ex: 600 });
  if (ok) return true;
  const cur = await kv.get(LOCK_KEY);
  if (cur?.until > now) return false;
  await kv.set(LOCK_KEY, { until }, { ex: 600 });
  return true;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.status(400).json({ ok: false, error: "mode must be bull or bear" });
      return;
    }

    if (!await tryAcquireLock()) {
      res.status(200).json({ ok: true, skipped: true, reason: "map refresh already running" });
      return;
    }

    const universe = await kv.get(UNIVERSE_KEY);
    if (!universe?.ok || !Array.isArray(universe.coins)) {
      res.status(200).json({ ok: false, error: "No moon universe available" });
      return;
    }

    // Filter: alleen munten met volume > 250k (zelfde als moon scan basicFilter)
    const candidates = universe.coins
      .filter(c => c.volume >= 250_000 && c.marketCap >= 1_000_000 && c.marketCap <= 800_000_000)
      .slice(0, 180);

    const map = {};
    for (const c of candidates) {
      map[c.symbol] = { symbol: c.symbol, name: c.name, volume: c.volume, marketCap: c.marketCap };
    }

    const out = { ok: true, ts: Date.now(), count: Object.keys(map).length, map };
    await kv.set(keyMoonObMap(mode), out, { ex: 60 * 60 });
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}