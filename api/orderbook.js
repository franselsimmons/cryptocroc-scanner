// /api/orderbook.js
// CryptoCroc — Bitget Orderbook (spot USDT)
// Returns: { symbol, mid, spreadPct, bidUsd, askUsd, obScore, depthPct, top:{bid,ask}, bids, asks }

export const config = { runtime: "nodejs" };

const fetchFn = globalThis.fetch;
if (!fetchFn) throw new Error("fetch is not available. Use Node.js runtime on Vercel.");

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normSymbol(raw) {
  if (!raw) return null;
  let s = String(raw).trim().toUpperCase();

  // Als iemand "PEPE/USDT" of "PEPE-USDT" geeft → maak PEPEUSDT
  s = s.replace("/", "").replace("-", "").replace("_", "");

  // Als het al eindigt op USDT, laat zo
  if (s.endsWith("USDT")) return s;

  // Anders plak USDT erachter
  return s + "USDT";
}

function sumDepth(levels, mid, depthPct, side) {
  // levels: [[price, size], ...]
  // side: "bids" => prijs >= mid*(1-depthPct)
  // side: "asks" => prijs <= mid*(1+depthPct)
  const low = mid * (1 - depthPct);
  const high = mid * (1 + depthPct);

  let usd = 0;
  let kept = [];

  for (let i = 0; i < levels.length; i++) {
    const p = toNum(levels[i][0]);
    const q = toNum(levels[i][1]);
    if (p == null || q == null) continue;

    const inBand =
      side === "bids" ? p >= low && p <= mid : p <= high && p >= mid;

    if (!inBand) continue;

    const v = p * q;
    usd += v;

    // bewaar een paar regels voor UI/debug
    if (kept.length < 20) kept.push({ p, q, usd: v });
  }

  return { usd, kept };
}

async function getBitgetOrderbook(symbol, limit = 50) {
  // We proberen eerst de nieuwe v2 spot endpoint.
  // Als die faalt, fallback naar oude v1.
  const urls = [
    `https://api.bitget.com/api/v2/spot/market/orderbook?symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
    `https://api.bitget.com/api/spot/v1/market/depth?symbol=${encodeURIComponent(symbol)}&type=step0&limit=${limit}`
  ];

  let lastErr = null;

  for (const url of urls) {
    try {
      const r = await fetchFn(url, { cache: "no-store" });
      const j = await r.json().catch(() => null);

      if (!r.ok || !j) {
        lastErr = new Error(`Bitget HTTP ${r.status}`);
        continue;
      }

      // v2 shape (typisch): { code, msg, data:{ bids:[], asks:[] } } (soms data:[{...}])
      // v1 shape (typisch): { code, msg, data:{ bids:[], asks:[] } }
      let data = j.data;

      // Soms is data een array met 1 item
      if (Array.isArray(data)) data = data[0];

      const bids = data?.bids || data?.bid || null;
      const asks = data?.asks || data?.ask || null;

      if (!Array.isArray(bids) || !Array.isArray(asks) || bids.length === 0 || asks.length === 0) {
        lastErr = new Error("Bitget: bids/asks ontbreekt");
        continue;
      }

      return { bids, asks };
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("Bitget orderbook fetch failed");
}

export default async function handler(req, res) {
  try {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");

    const raw = req.query.symbol || req.query.sym || req.query.ticker;
    const depthPct = req.query.depthPct ? Math.max(0.001, Math.min(0.1, Number(req.query.depthPct))) : 0.02;
    const limit = req.query.limit ? Math.max(10, Math.min(200, Number(req.query.limit))) : 50;

    const symbol = normSymbol(raw);
    if (!symbol) {
      res.status(400).json({ ok: false, error: "Missing symbol" });
      return;
    }

    const { bids, asks } = await getBitgetOrderbook(symbol, limit);

    // Best bid/ask
    const bestBid = toNum(bids[0]?.[0]);
    const bestAsk = toNum(asks[0]?.[0]);

    if (bestBid == null || bestAsk == null || bestBid <= 0 || bestAsk <= 0) {
      res.status(502).json({ ok: false, error: "Bad orderbook prices" });
      return;
    }

    const mid = (bestBid + bestAsk) / 2;
    const spreadPct = ((bestAsk - bestBid) / mid) * 100;

    // Depth sums binnen 2% rond mid
    const bidDepth = sumDepth(bids, mid, depthPct, "bids");
    const askDepth = sumDepth(asks, mid, depthPct, "asks");

    const bidUsd = bidDepth.usd;
    const askUsd = askDepth.usd;

    const denom = bidUsd + askUsd;
    const obScore = denom > 0 ? (bidUsd - askUsd) / denom : 0;

    res.status(200).json({
      ok: true,
      symbol,
      depthPct,
      mid,
      spreadPct,
      bidUsd,
      askUsd,
      obScore,
      top: { bid: bestBid, ask: bestAsk },
      // kleine sample zodat je UI “strak” kan tekenen
      bids: bidDepth.kept,
      asks: askDepth.kept
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e?.message || "Unknown error"
    });
  }
}
