// lib/discordRouter.js

export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = String(stage || "").toUpperCase();
  const k = String(kind || "signal").toLowerCase();

  // =====================================
  // 1) Portfolio events -> alleen portfolio
  // =====================================
  if (
    k === "portfolio" ||
    s === "HOLD" ||
    s === "SELL" ||
    s === "TP" ||
    s === "SL" ||
    s === "EXIT"
  ) {
    return process.env.DISCORD_WEBHOOK_PORTFOLIO || null;
  }

  // =====================================
  // 2) MAIN funnel
  // =====================================
  if (src === "main") {
    if (s === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR || null;
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_PRO_RADAR || null;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT || null;
    if (s === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE || null;

    return null;
  }

  // =====================================
  // 3) MOON funnel
  // =====================================
  if (src === "moon") {
    if (s === "RADAR") return null;
    if (s === "BUILDUP") return null;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT || null;

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

export async function sendSignal({ source, stage, kind = "signal", ...rest }, sendFn, formatFn) {
  const webhook = getDiscordWebhookForSignal({ source, stage, kind });
  if (!webhook) return false;

  const message = formatFn({ source, stage, kind, ...rest });
  if (!message) return false;

  const title = `${String(source || "").toUpperCase()} ${String(stage || "").toUpperCase()} • ${rest?.coin?.symbol || "-"}`;
  await sendFn(webhook, title, message);

  return true;
}