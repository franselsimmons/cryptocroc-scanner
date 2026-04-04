// --------------------------------
// Webhook mapping (Exact volgens Vercel screenshots)
// --------------------------------
export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // Portfolio meldingen (Gevonden in screenshot 4)
  if (k === "portfolio") return process.env.DISCORD_WEBHOOK_PORTFOLIO;
  
  // Position updates sturen we (voorlopig) niet via deze signal-router tenzij specifiek ingesteld
  if (k === "position_update") return null;

  // --- 1. EXECUTION ENGINE (Afbeelding 2) ---
  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;

  // --- 2. PRE-TRADE / ELITE WATCH (Afbeelding 1) ---
  if (k === "elite_watch" || k === "pre_trade") return process.env.DISCORD_WEBHOOK_PRE_TRADE;

  // --- 3. SCANNER SIGNALEN ---
  if (k === "signal") {
    // RADAR (Afbeelding 3 & 4)
    if (s === "RADAR") {
      // Moon heeft een specifieke radar, anders fallback naar market radar
      if (src === "moon") return process.env.DISCORD_WEBHOOK_RADAR_MOON || process.env.DISCORD_WEBHOOK_MARKET_RADAR;
      return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
    }

    // BUILDUP (Afbeelding 3)
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH;

    // ALMOST (Afbeelding 3)
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_HIGH_ALERT;

    // ENTRY / PRO BUCKETS (Afbeelding 3)
    if (
      s === "ENTRY" ||
      s === "TRADE_READY" ||
      s === "OPEN" ||
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
    }

    // Fallback voor elk ander valide signaal dat we niet specifiek hebben gevangen
    return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }

  return null;
}
