// ========== BESTAANDE CODE (onveranderd) ==========
// ... (hier staat jouw bestaande implementatie van readEvents, pushEvent, etc.)
// Zorg dat readEvents al bestaat. Indien niet, voeg het toe.

// ========== NIEUWE FUNCTIES VOOR analyze-all ==========
export function inferSystemFromTradeId(id) {
  const v = String(id || "").toLowerCase();
  if (v.startsWith("moon_")) return "moon";
  if (v.startsWith("main_")) return "main";
  return "unknown";
}

export async function readTradeEventBook(limit = 5000) {
  const opened = await readEvents("trade_opened", limit);
  const closed = await readEvents("trade_closed", limit);

  return {
    opened: Array.isArray(opened) ? opened : [],
    closed: Array.isArray(closed) ? closed : [],
  };
}