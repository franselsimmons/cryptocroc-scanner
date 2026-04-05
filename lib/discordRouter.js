// lib/discordRouter.js

import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

const up = (str) => (str ? String(str).toUpperCase() : "UNKNOWN");

function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "main").toLowerCase();
  const st = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // 1. Trade Lifecycle
  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;
  if (k === "elite_watch") return process.env.DISCORD_WEBHOOK_PRE_TRADE;

  // 2. High Priority Alerts
  if (k === "alert" || st === "ENTRY" || st === "ALMOST") {
    return process.env.DISCORD_WEBHOOK_HIGH_ALERT || process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
  }

  // 3. Scanner & Moon Routing
  if (st === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH;
  
  if (st === "RADAR") {
    if (src === "moon") {
      // FIX: Altijd een kanaal voor moon, zelfs als er geen aparte webhook is
      return process.env.DISCORD_WEBHOOK_RADAR_MOON || process.env.DISCORD_WEBHOOK_MARKET_RADAR;
    }
    return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }

  return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
}

async function shouldSendDedupe({ kind, symbol, stage, source }) {
  const st = up(stage);
  const isLowTier = (st === "RADAR" || st === "BUILDUP");
  const expiry = isLowTier ? 43200 : 90; // 12 uur voor lagere kanalen
  
  const key = `dedupe:${kind}:${symbol}:${st}:${source}`;
  if (!process.env.KV_REST_API_URL) return true;

  try {
    const ok = await kv.set(key, "1", { nx: true, ex: expiry });
    return !!ok;
  } catch (e) {
    return true; 
  }
}

export async function sendSignal(payload) {
  const { source, stage, coin, kind = "signal", pnl } = payload;
  const symbol = up(coin?.symbol);
  const side = up(coin?.side);
  
  if (!symbol || symbol === "UNKNOWN") return false;

  const webhook = getDiscordWebhookForSignal({ source, stage, kind });
  if (!webhook) return false;

  if (!(await shouldSendDedupe({ kind, symbol, stage, source }))) return false;

  const message = formatSignalMessage({ source, stage, kind, coin, pnl });
  const color = getDiscordColor({ kind, pnl });
  const title = `${side === "SHORT" ? "🔴" : "🟢"} ${up(kind)} • ${symbol}`;

  return await sendDiscord(webhook, title, message, color);
}
