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

  // Niet automatisch gebruiken
  if (k === "portfolio") {
    return null;
  }

  // Echte trade open -> ELITE kanaal
  if (k === "trade_opened") {
    return process.env.DISCORD_WEBHOOK_TRADE_OPENED || null;
  }

  // Echte trade close -> ELITE close kanaal
  if (k === "trade_closed") {
    return process.env.DISCORD_WEBHOOK_TRADE_CLOSED || null;
  }

  // Position updates niet sturen
  if (k === "position_update") {
    return null;
  }

  // PRE TRADE (ALMOST setups voor ELITE gebruikers)
  if (k === "signal" && s === "ALMOST") {
    return process.env.DISCORD_WEBHOOK_PRE_TRADE || null;
  }

  // MAIN funnel
  if (src === "main") {
    if (s === "RADAR") return process.env.DISCORD_WEBHOOK_MARKET_RADAR || null;
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH || null;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_PRE_TRADE || null; // valt normaal al onder de pre-trade regel, maar voor de zekerheid

    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || null;
    }

    return null;
  }

  // MOON funnel
  if (src === "moon") {
    if (s === "RADAR") {
      return (
        process.env.DISCORD_WEBHOOK_RADAR_MOON ||
        process.env.DISCORD_WEBHOOK_MARKET_RADAR ||
        null
      );
    }

    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH || null;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_PRE_TRADE || null;

    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || null;
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

  if (k === "trade_opened") {
    return n(process.env.DISCORD_COOLDOWN_TRADE_OPENED_SEC, 1800);
  }

  if (k === "trade_closed") {
    return n(process.env.DISCORD_COOLDOWN_TRADE_CLOSED_SEC, 1800);
  }

  if (k === "position_update") {
    return n(process.env.DISCORD_COOLDOWN_POSITION_UPDATE_SEC, 900);
  }

  if (k === "portfolio") {
    return n(process.env.DISCORD_COOLDOWN_PORTFOLIO_SEC, 900);
  }

  if (src === "main") {
    if (s === "RADAR") return n(process.env.DISCORD_COOLDOWN_RADAR_SEC, 21600);
    if (s === "BUILDUP") return n(process.env.DISCORD_COOLDOWN_BUILDUP_SEC, 14400);
    if (s === "ALMOST") return n(process.env.DISCORD_COOLDOWN_ALMOST_SEC, 10800);

    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return n(process.env.DISCORD_COOLDOWN_ENTRY_SEC, 7200);
    }
  }

  if (src === "moon") {
    if (s === "RADAR") return n(process.env.DISCORD_COOLDOWN_MOON_RADAR_SEC, 21600);
    if (s === "BUILDUP") return n(process.env.DISCORD_COOLDOWN_MOON_BUILDUP_SEC, 14400);
    if (s === "ALMOST") return n(process.env.DISCORD_COOLDOWN_MOON_ALMOST_SEC, 10800);

    if (
      s === "ELITE_IGNITION" ||
      s === "ELITE_EXPANSION" ||
      s === "ELITE_CASCADE"
    ) {
      return n(process.env.DISCORD_COOLDOWN_MOON_ELITE_SEC, 7200);
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
  pnl,
  reason,
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
    kind,
    pnl,
    reason,
  });

  const title = `${source?.toUpperCase()} ${stage?.toUpperCase()} • ${symbol}`;

  await sendDiscord(webhook, title, message);
  return true;
}