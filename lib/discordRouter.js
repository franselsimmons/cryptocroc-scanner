// lib/discordRouter.js

import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage } from "./formatDiscord.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function up(x) {
  return String(x || "").toUpperCase();
}

function cooldownKey({ source, mode, stage, symbol, kind }) {
  return [
    "discord",
    String(kind || "signal").toLowerCase(),
    String(source || "").toLowerCase(),
    String(mode || "").toLowerCase(),
    up(stage),
    up(symbol),
  ].join(":");
}

export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = String(stage || "").toUpperCase();
  const k = String(kind || "signal").toLowerCase();

  // portfolio events
  if (k === "portfolio") {
    return process.env.DISCORD_WEBHOOK_PORTFOLIO || null;
  }

  // MAIN funnel
  if (src === "main") {
    if (s === "RADAR") return process.env.DISCORD_WEBHOOK_RADAR || null;
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_PRO_RADAR || null;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_EXPERT || null;
    if (s === "ENTRY") return process.env.DISCORD_WEBHOOK_ELITE || null;
    return null;
  }

  // MOON funnel
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

async function shouldSendWithCooldown({
  source,
  mode,
  stage,
  symbol,
  kind = "signal",
  cooldownSec,
}) {
  const key = cooldownKey({ source, mode, stage, symbol, kind });

  // NX = alleen zetten als key nog niet bestaat
  const ok = await kv.set(
    key,
    { ts: Date.now() },
    { nx: true, ex: cooldownSec }
  );

  return !!ok;
}

function getCooldownSec({ source, stage, kind }) {
  const k = String(kind || "signal").toLowerCase();
  const src = String(source || "").toLowerCase();
  const s = String(stage || "").toUpperCase();

  if (k === "portfolio") {
    return n(process.env.DISCORD_COOLDOWN_PORTFOLIO_SEC, 900); // 15 min
  }

  if (src === "main") {
    if (s === "RADAR") return n(process.env.DISCORD_COOLDOWN_RADAR_SEC, 21600); // 6 uur
    if (s === "BUILDUP") return n(process.env.DISCORD_COOLDOWN_BUILDUP_SEC, 14400); // 4 uur
    if (s === "ALMOST") return n(process.env.DISCORD_COOLDOWN_ALMOST_SEC, 10800); // 3 uur
    if (s === "ENTRY") return n(process.env.DISCORD_COOLDOWN_ENTRY_SEC, 7200); // 2 uur
  }

  if (src === "moon") {
    if (s === "ALMOST") return n(process.env.DISCORD_COOLDOWN_MOON_ALMOST_SEC, 10800); // 3 uur
    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return n(process.env.DISCORD_COOLDOWN_MOON_ELITE_SEC, 7200); // 2 uur
    }
  }

  return 7200;
}

export async function sendSignal({
  source,
  stage,
  mode,
  coin,
  btcState,
  kind = "signal",
}) {
  const webhook = getDiscordWebhookForSignal({ source, stage, kind });
  if (!webhook) return false;

  const symbol = coin?.symbol;
  if (!symbol) return false;

  const cooldownSec = getCooldownSec({ source, stage, kind });

  const allowed = await shouldSendWithCooldown({
    source,
    mode,
    stage,
    symbol,
    kind,
    cooldownSec,
  });

  if (!allowed) {
    return false;
  }

  const message = formatSignalMessage({
    source,
    stage,
    mode,
    coin,
    btcState,
  });

  const title = `${String(source).toUpperCase()} ${String(stage).toUpperCase()} • ${symbol}`;

  await sendDiscord(webhook, title, message);
  return true;
}