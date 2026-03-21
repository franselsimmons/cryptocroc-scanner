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

function isMainProStage(source, stage) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);

  return (
    src === "main" &&
    (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE")
  );
}

function isMoonProStage(source, stage) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);

  return (
    src === "moon" &&
    (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION")
  );
}

export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // nooit sturen
  if (k === "portfolio") return null;
  if (k === "position_update") return null;

  // ELITE — Trade Desk
  if (k === "elite_watch") {
    return process.env.DISCORD_WEBHOOK_PRE_TRADE || null;
  }

  if (k === "trade_opened") {
    return process.env.DISCORD_WEBHOOK_TRADE_OPENED || null;
  }

  if (k === "trade_closed") {
    return process.env.DISCORD_WEBHOOK_TRADE_CLOSED || null;
  }

  // Scannerflow
  if (k === "signal") {
    // FREE — main/moon BUILDUP
    if (s === "BUILDUP") {
      return process.env.DISCORD_WEBHOOK_SETUP_WATCH || null;
    }

    // STARTER — main/moon ALMOST
    if (s === "ALMOST") {
      return process.env.DISCORD_WEBHOOK_HIGH_ALERT || null;
    }

    // PRO — main elite stages
    if (isMainProStage(src, s)) {
      return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || null;
    }

    // PRO — moon elite stages
    if (isMoonProStage(src, s)) {
      return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || null;
    }

    // optioneel radar
    if (s === "RADAR") {
      if (src === "moon") {
        return (
          process.env.DISCORD_WEBHOOK_RADAR_MOON ||
          process.env.DISCORD_WEBHOOK_MARKET_RADAR ||
          null
        );
      }
      return process.env.DISCORD_WEBHOOK_MARKET_RADAR || null;
    }
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
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

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

  if (k === "elite_watch") {
    return n(process.env.DISCORD_COOLDOWN_PRE_TRADE_SEC, 10800);
  }

  if (k === "signal") {
    // PRO — main elite stages
    if (isMainProStage(src, s)) {
      return n(process.env.DISCORD_COOLDOWN_MAIN_ENTRY_SEC, 7200);
    }

    // PRO — moon elite stages
    if (isMoonProStage(src, s)) {
      return n(process.env.DISCORD_COOLDOWN_MOON_ELITE_SEC, 7200);
    }

    // STARTER — ALMOST
    if (s === "ALMOST") {
      if (src === "moon") {
        return n(process.env.DISCORD_COOLDOWN_MOON_ALMOST_SEC, 10800);
      }
      return n(process.env.DISCORD_COOLDOWN_ALMOST_SEC, 10800);
    }

    // FREE — BUILDUP
    if (s === "BUILDUP") {
      if (src === "moon") {
        return n(process.env.DISCORD_COOLDOWN_MOON_BUILDUP_SEC, 14400);
      }
      return n(process.env.DISCORD_COOLDOWN_BUILDUP_SEC, 14400);
    }

    // optioneel radar
    if (s === "RADAR") {
      if (src === "moon") {
        return n(process.env.DISCORD_COOLDOWN_MOON_RADAR_SEC, 21600);
      }
      return n(process.env.DISCORD_COOLDOWN_RADAR_SEC, 21600);
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

  const title = `${String(source || "").toUpperCase()} ${up(stage)} • ${symbol}`;

  await sendDiscord(webhook, title, message);
  return true;
}