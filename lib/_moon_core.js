// Vervang de bestaande getBitgetSpotUsdtSymbols door deze:
export async function getBitgetSpotUsdtSymbols() {
  try {
    const r = await fetch("https://api.bitget.com/api/v2/spot/public/symbols");
    if (!r.ok) {
      console.error("Bitget symbols HTTP error:", r.status);
      return new Set();
    }

    const json = await r.json();
    if (String(json?.code || "") !== "00000") {
      console.error("Bitget symbols API error:", json);
      return new Set();
    }

    const set = new Set();

    for (const s of json.data || []) {
      const status = String(s?.status || "").toLowerCase();
      const quoteCoin = String(s?.quoteCoin || "").toUpperCase();
      const baseCoin = String(s?.baseCoin || "").toUpperCase();

      if (status !== "online") continue;
      if (quoteCoin !== "USDT") continue;
      if (!baseCoin) continue;

      set.add(baseCoin);
    }

    console.log("Bitget USDT base symbols loaded:", set.size);
    return set;
  } catch (e) {
    console.error("getBitgetSpotUsdtSymbols error:", e);
    return new Set();
  }
}