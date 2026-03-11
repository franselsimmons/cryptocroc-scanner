// lib/discordRouter.js
// Bepaalt naar welke Discord-webhook een signaal gestuurd moet worden
// Gebruikt environment variables: DISCORD_WEBHOOK_RADAR, DISCORD_WEBHOOK_PRO_RADAR,
// DISCORD_WEBHOOK_EXPERT, DISCORD_WEBHOOK_ELITE, DISCORD_WEBHOOK_PORTFOLIO

/**
 * Geeft de juiste webhook-URL voor een signaal.
 * @param {Object} params
 * @param {string} params.source - "MAIN" of "MOON"
 * @param {string} params.stage - bijv. "RADAR", "BUILDUP", "ALMOST", "ENTRY", "ELITE", "IGNITION", "EXPANSION", "CASCADE"
 * @param {string} params.kind - "signal" of "portfolio" (portfolio = TP/SL/HOLD/EXIT)
 * @returns {string|null} webhook URL of null als er geen gestuurd moet worden
 */
export function getDiscordWebhookForSignal({ source, stage, kind }) {
  // Portfolio-gerelateerde berichten (TP/SL/HOLD/EXIT) gaan altijd naar #portfolio
  if (kind === "portfolio") {
    return process.env.DISCORD_WEBHOOK_PORTFOLIO;
  }

  const s = String(stage || "").toUpperCase();
  const src = String(source || "").toLowerCase();

  // MAIN funnel
  if (src === "main") {
    if (s === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_PRO_RADAR;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT;
    if (s === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE;
  }

  // MOON funnel
  if (src === "moon") {
    // MOON ALMOST → #expert
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT;
    // MOON ELITE / IGNITION / EXPANSION / CASCADE → #elite
    if (s === "ELITE" || s === "IGNITION" || s === "EXPANSION" || s === "CASCADE") {
      return process.env.DISCORD_WEBHOOK_ELITE;
    }
    // MOON RADAR / BUILDUP sturen we niet standaard (kunnen optioneel naar RADAR als teaser)
    // return process.env.DISCORD_WEBHOOK_RADAR; // indien gewenst
  }

  // Geen match → geen bericht
  return null;
}

/**
 * Stuurt een signaal naar het juiste Discord-kanaal.
 * @param {Object} params - bevat source, stage, mode, coin, btcState, kind
 * @param {Function} sendFn - de sendDiscord functie (dependency injection)
 */
export async function sendSignal({ source, stage, mode, coin, btcState, kind = "signal" }, sendFn) {
  const webhook = getDiscordWebhookForSignal({ source, stage, kind });
  if (!webhook) return;

  const message = formatSignalMessage({ source, stage, mode, coin, btcState });
  const title = `${source} ${stage} • ${coin?.symbol}`;
  await sendFn(webhook, title, message);
}

// Let op: in sendSignal wordt aangenomen dat formatSignalMessage beschikbaar is.
// Je moet deze functie importeren waar je sendSignal gebruikt.