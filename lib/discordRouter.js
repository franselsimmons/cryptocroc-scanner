// lib/discordRouter.js

export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = String(stage || "").toUpperCase();
  const k = String(kind || "signal").toLowerCase();

  // =========================
  // 1) Portfolio events
  // =========================
  // HOLD / SELL / TP / SL / EXIT horen ALLEEN in #portfolio
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

    // Alleen ENTRY mag naar elite
    if (s === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE || null;

    // HOLD / SELL nooit als "signal" routen
    return null;
  }

  // =========================
  // 3) MOON funnel
  // =========================
  if (src === "moon") {
    // Moon radar/buildup/almost NIET naar elite
    if (s === "RADAR") return null;
    if (s === "BUILDUP") return null;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT || null;

    // Alleen echte moon elite-stages naar elite
    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return process.env.DISCORD_WEBHOOK_ELITE || null;
    }

    // HOLD / SELL nooit als normaal signaal
    return null;
  }

  return null;
}