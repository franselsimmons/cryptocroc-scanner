// lib/discordRouter.js

import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

const up = (str) => (str ? String(str).toUpperCase() : "UNKNOWN");

function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const st = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // Trade lifecycle
  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;

  // Elite pre-trade
  if (k === "elite_watch") return process.env.DISCORD_WEBHOOK_PRE_TRADE;

  // ✅ FIX: MOON elite stages mogen NOOIT naar market radar
  // MOON ELITE/ENTRY/ALMOST -> PRO kanaal (trade-alerts), fallback high-alert
  if (src === "moon") {
    if (st.startsWith("ELITE_") || st === "ENTRY" || st === "ALMOST") {
      return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || process.env.DISCORD_WEBHOOK_HIGH_ALERT;
    }
  }

  // Alerts / High alert (blijft zoals jij had)
  if (k === "alert" || st === "ENTRY" || st === "ALMOST") {
    return process.env.DISCORD_WEBHOOK_HIGH_ALERT || process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
  }

  // Buildup
  if (st === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH;

  // Radar
  if (st === "RADAR") {
    if (src === "moon") return process.env.DISCORD_WEBHOOK_RADAR_MOON || process.env.DISCORD_WEBHOOK_MARKET_RADAR;
    return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }

  // Fallback
  return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
}

async function shouldSendDedupe({ kind, symbol, stage, source }) {
  // Cooldown: 12 uur (43200s) voor RADAR/BUILDUP, 90s voor de rest
  const st = up(stage);
  const isLowTier = st === "RADAR" || st === "BUILDUP";
  const expiry = isLowTier ? 43200 : 90;

  const key = `dedupe:${kind}:${symbol}:${st}:${source}`;
  if (!process.env.KV_REST_API_URL) return true;

  try {
    const ok = await kv.set(key, "1", { nx: true, ex: expiry });
    return !!ok;
  } catch {
    return true;
  }
}

export async function sendSignal(payload) {
  const { source, stage, coin, kind = "signal", pnl } = payload;
  const symbol = up(coin?.symbol);

  if (!symbol || symbol === "UNKNOWN") return false;

  const webhook = getDiscordWebhookForSignal({ source, stage, kind });
  if (!webhook) return false;

  // Extra check: Geen ALPHA (Moon) in algemene Market Radar kanaal (spam-preventie)
  if (up(stage) === "RADAR" && String(source).toLowerCase() === "moon" && !process.env.DISCORD_WEBHOOK_RADAR_MOON) {
    return false;
  }

  if (!(await shouldSendDedupe({ kind, symbol, stage, source }))) return false;

  const message = formatSignalMessage({ source, stage, kind, coin, pnl });
  const color = getDiscordColor({ kind, pnl });
  const title = `${up(kind)} • ${symbol}`;

  return await sendDiscord(webhook, title, message, color);
}