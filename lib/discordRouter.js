// lib/discordRouter.js
import { formatSignalMessage } from "./formatDiscord.js";

/**
 * Geeft de juiste webhook-URL voor een signaal.
 * @param {Object} params
 * @param {string} params.source - "MAIN" of "MOON"
 * @param {string} params.stage - bijv. "RADAR", "BUILDUP", "ALMOST", "ENTRY", "ELITE", "IGNITION", "EXPANSION", "CASCADE"
 * @param {string} params.kind - "signal" of "portfolio"
 * @returns {string|null}
 */
export function getDiscordWebhookForSignal({ source, stage, kind }) {
  if (kind === "portfolio") {
    return process.env.DISCORD_WEBHOOK_PORTFOLIO;
  }

  const s = String(stage || "").toUpperCase();
  const src = String(source || "").toLowerCase();

  if (src === "main") {
    if (s === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR;
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_PRO_RADAR;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT;
    if (s === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE;
  }

  if (src === "moon") {
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT;
    if (
      s === "ELITE" ||
      s === "IGNITION" ||
      s === "EXPANSION" ||
      s === "CASCADE"
    ) {
      return process.env.DISCORD_WEBHOOK_ELITE;
    }
  }

  return null;
}

/**
 * Stuurt een signaal naar het juiste Discord-kanaal.
 * @param {Object} params - bevat source, stage, mode, coin, btcState, kind
 * @param {Function} sendFn - de sendDiscord functie (dependency injection)
 */
export async function sendSignal(
  { source, stage, mode, coin, btcState, kind = "signal" },
  sendFn
) {
  const webhook = getDiscordWebhookForSignal({ source, stage, kind });
  if (!webhook) return;

  const message = formatSignalMessage({
    source,
    stage,
    mode,
    coin,
    btcState,
  });

  const title = `${String(source || "").toUpperCase()} ${String(stage || "").toUpperCase()} • ${coin?.symbol || "-"}`;

  await sendFn(webhook, title, message);
}