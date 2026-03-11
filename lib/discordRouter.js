// lib/discordRouter.js

import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage } from "./formatDiscord.js";

/**
 * Bepaalt welke Discord webhook gebruikt moet worden
 */
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

    // Alleen ENTRY naar elite
    if (s === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE || null;

    return null;
  }

  // =========================
  // 3) MOON funnel
  // =========================
  if (src === "moon") {

    // radar / buildup niet posten
    if (s === "RADAR") return null;
    if (s === "BUILDUP") return null;

    // almost naar expert
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT || null;

    // echte moon elite
    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return process.env.DISCORD_WEBHOOK_ELITE || null;
    }

    return null;
  }

  return null;
}

/**
 * Stuurt een coin signaal naar Discord
 */
export async function sendSignal({
  source,
  stage,
  mode,
  coin,
  btcState,
  kind = "signal"
}) {

  const webhook = getDiscordWebhookForSignal({
    source,
    stage,
    kind
  });

  if (!webhook) return;

  const message = formatSignalMessage({
    source,
    stage,
    mode,
    coin,
    btcState
  });

  const title = `${source.toUpperCase()} ${stage} • ${coin?.symbol}`;

  await sendDiscord(
    webhook,
    title,
    message
  );
}