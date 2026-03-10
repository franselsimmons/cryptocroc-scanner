import { kv } from "@vercel/kv";
import { RUNTIME_CONFIG, requireSecret } from "../../../lib/_runtime.js";
import {
  keyMoonObMap,
  keyObSamples,
  keyObResult,
  keyObResultMapTs,
} from "../../../lib/_moon_core.js";

export const config = RUNTIME_CONFIG;

const BITGET_OB = "https://api.bitget.com/api/v2/spot/market/orderbook";
const SAMPLES_WINDOW_SEC = 3 * 3600; // 3 uur (zelfde als main)
const SAMPLES_MAX = 24;
const SAMPLE_TTL_SEC = 60 * 60 * 48; // 48 uur

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOrderbook(symbol) {
  try {
    const url = `${BITGET_OB}?symbol=${symbol}USDT&type=step0&limit=20`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    if (String(j?.code || "") !== "00000") return null;
    const bids = j?.data?.bids || [];
    const asks = j?.data?.asks || [];
    if (!bids.length || !asks.length) return null;

    const bestBid = n(bids[0][0]);
    const bestAsk = n(asks[0][0]);
    if (!(bestBid > 0 && bestAsk > 0)) return null;

    const spread = (bestAsk - bestBid) / bestBid;
    const depthBid = bids.slice(0, 5).reduce((a, b) => a + n(b[1]) * n(b[0]), 0);
    const depthAsk = asks.slice(0, 5).reduce((a, b) => a + n(b[1]) * n(b[0]), 0);

    return {
      spreadPct: spread * 100,
      depthBidUsd: depthBid,
      depthAskUsd: depthAsk,
      depthMinUsd1p: Math.min(depthBid, depthAsk),
      score: (depthBid - depthAsk) / (depthBid + depthAsk || 1),
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = String(req.query?.mode || "bull").toLowerCase();
    if (mode !== "bull" && mode !== "bear") {
      res.status(400).json({ ok: false, error: "mode must be bull or bear" });
      return;
    }

    const mapKey = keyMoonObMap(mode);
    const mapData = await kv.get(mapKey);
    if (!mapData?.ok || !mapData.map) {
      res.status(200).json({ ok: false, error: "No OB map available" });
      return;
    }

    const symbols = Object.keys(mapData.map);
    const now = Date.now();
    const results = [];

    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const ob = await fetchOrderbook(sym);
      if (!ob) continue;

      // Sample opslaan
      const sampleKey = keyObSamples(mode, sym);
      let samples = (await kv.get(sampleKey)) || [];
      if (!Array.isArray(samples)) samples = [];

      samples.push({ ts: now, ...ob });
      // bewaar alleen laatste SAMPLES_WINDOW_SEC
      const cutoff = now - SAMPLES_WINDOW_SEC * 1000;
      samples = samples.filter(s => s.ts >= cutoff).slice(-SAMPLES_MAX);
      await kv.set(sampleKey, samples, { ex: SAMPLE_TTL_SEC });

      // Resultaat berekenen (gewoon de laatste waarde, geen slope)
      const result = {
        ts: now,
        ...ob,
      };
      await kv.set(keyObResult(mode, sym), result, { ex: SAMPLE_TTL_SEC });

      results.push({ symbol: sym, ok: true });

      await sleep(120); // kleine pauze om rate limits te mijden
    }

    // Update timestamp map
    await kv.set(keyObResultMapTs(mode), now, { ex: SAMPLE_TTL_SEC });

    res.status(200).json({ ok: true, mode, sampled: results.length, ts: now });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}