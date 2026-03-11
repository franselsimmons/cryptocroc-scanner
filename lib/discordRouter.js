// lib/discordRouter.js

/**
 * Bepaalt de juiste Discord webhook op basis van bron, stage en type.
 * @param {Object} params
 * @param {string} params.source - "main" of "moon"
 * @param {string} params.stage - bijv. "RADAR", "ENTRY", "HOLD", "ELITE_IGNITION"
 * @param {string} params.kind - "signal" of "portfolio"
 * @returns {string|null} Webhook URL of null (geen Discord)
 */
export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = String(stage || "").toUpperCase();
  const k = String(kind || "signal").toLowerCase();

  // =========================
  // 1) Portfolio events gaan ALTIJD naar #portfolio
  // =========================
  if (k === "portfolio") {
    return process.env.DISCORD_WEBHOOK_PORTFOLIO || null;
  }

  // =========================
  // 2) MAIN funnel
  // =========================
  if (src === "main") {
    if (s === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR || null;
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_PRO_RADAR || null;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT || null;
    // ALLEEN ENTRY mag naar #elite
    if (s === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE || null;

    // HOLD / SELL / TP / SL / EXIT worden nooit als "signal" verstuurd,
    // maar mocht er toch een signal binnenkomen, dan negeren we die hier.
    return null;
  }

  // =========================
  // 3) MOON funnel
  // =========================
  if (src === "moon") {
    // RADAR en BUILDUP sturen we (nog) niet naar Discord
    if (s === "RADAR") return null;
    if (s === "BUILDUP") return null;
    // ALMOST gaat naar #expert
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT || null;

    // Alleen echte moon elite‑signalen naar #elite
    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return process.env.DISCORD_WEBHOOK_ELITE || null;
    }

    // HOLD / SELL / TP / SL / EXIT horen bij portfolio en worden elders afgevangen
    return null;
  }

  return null;
}