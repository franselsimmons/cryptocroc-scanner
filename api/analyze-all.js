import { kv } from "@vercel/kv";

// =============================
// ✅ GEEN keys.js meer!
// =============================
const SECRET = process.env.SECRET || "lara-roos";

// =============================
// Helper: auth check
// =============================
function requireSecret(req, res) {
  const s = req.query?.secret;
  if (!s || s !== SECRET) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return false;
  }
  return true;
}

// =============================
// MAIN HANDLER
// =============================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    // =============================
    // MAIN ophalen
    // =============================
    const main = await fetch(
      `${process.env.BASE_URL}/api/analyze-main?secret=${SECRET}`
    ).then(r => r.json()).catch(() => null);

    // =============================
    // MOON ophalen (BULL + BEAR)
    // =============================
    const moonBull = await fetch(
      `${process.env.BASE_URL}/api/moon?mode=bull&secret=${SECRET}`
    ).then(r => r.json()).catch(() => null);

    const moonBear = await fetch(
      `${process.env.BASE_URL}/api/moon?mode=bear&secret=${SECRET}`
    ).then(r => r.json()).catch(() => null);

    // =============================
    // TRADE ophalen
    // =============================
    const trade = await fetch(
      `${process.env.BASE_URL}/api/trade?secret=${SECRET}`
    ).then(r => r.json()).catch(() => null);

    // =============================
    // RESULTAAT (ALLES SAMEN)
    // =============================
    const result = {
      ok: true,
      ts: Date.now(),

      main: main || { error: "main_failed" },

      moon: {
        bull: moonBull || { error: "moon_bull_failed" },
        bear: moonBear || { error: "moon_bear_failed" },
      },

      trade: trade || { error: "trade_failed" },
    };

    res.status(200).json(result);

  } catch (err) {
    console.error("analyze-all error:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}