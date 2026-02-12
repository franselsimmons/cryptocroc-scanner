import { fetchFn, json, asNum } from "./_util.js";

async function cgBtcRange24h() {
  // CoinGecko simple price: geeft high/low 24h voor BTC
  const url =
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_high=true&include_24hr_low=true";
  const r = await fetchFn(url);
  if (!r.ok) throw new Error("CoinGecko BTC fetch failed");
  const j = await r.json();
  const hi = asNum(j?.bitcoin?.usd_24h_high, 0);
  const lo = asNum(j?.bitcoin?.usd_24h_low, 0);
  if (!hi || !lo) return { ok: true, range24h: null, regime: "UNKNOWN" };
  const range24h = (hi - lo) / lo; // ratio
  const regime = range24h > 0.045 ? "HIGH_VOL" : "GRIND";
  return { ok: true, range24h, regime };
}

export default async function handler(req, res) {
  try {
    const out = await cgBtcRange24h();
    json(res, 200, out);
  } catch (e) {
    json(res, 200, { ok: false, error: String(e?.message || e) });
  }
}
