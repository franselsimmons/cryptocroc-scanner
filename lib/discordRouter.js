// lib/discordRouter.js

import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

const up = (str) => (str ? String(str).toUpperCase() : "UNKNOWN");

function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "main").toLowerCase();
  const st = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // 1. Trade Lifecycle (Elite)
  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;
  if (k === "elite_watch") return process.env.DISCORD_WEBHOOK_PRE_TRADE;

  // 2. Pro/High Alerts (Prime)
  if (k === "alert" || st === "ENTRY" || st === "ALMOST") {
    return process.env.DISCORD_WEBHOOK_HIGH_ALERT || process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
  }

  // 3. Scanner & Radar
  if (st === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH;
  
  if (st === "RADAR") {
    // FIX: Als het Moon is, probeer eerst Moon-webhook, anders gewone Radar
    if (src === "moon") {
      return process.env.DISCORD_WEBHOOK_RADAR_MOON || process.env.DISCORD_WEBHOOK_MARKET_RADAR;
    }
    return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }

  // Ultieme fallback: stuur het ergens heen zodat het niet verloren gaat
  return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
}

async function shouldSendDedupe({ kind, symbol, stage, source }) {
  const st = up(stage);
  const isLowTier = (st === "RADAR" || st === "BUILDUP");
  const expiry = isLowTier ? 43200 : 90; // 12 uur voor lage kanalen, 90s voor trades
  
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
  
  if (!symbol || symbol === "UNKNOWN") return false;

  const webhook = getDiscordWebhookForSignal({ source, stage, kind });
  if (!webhook) {
    console.error(`[Discord] Geen webhook gevonden voor ${symbol} (${source})`);
    return false;
  }

  // Controleer deduplicatie (spam-filter)
  if (!(await shouldSendDedupe({ kind, symbol, stage, source }))) {
    console.log(`[Discord] Overslaan (dedupe): ${symbol}`);
    return false;
  }

  const message = formatSignalMessage({ source, stage, kind, coin, pnl });
  const color = getDiscordColor({ kind, pnl });
  const title = `${up(kind)} • ${symbol}`;

  try {
    return await sendDiscord(webhook, title, message, color);
  } catch (error) {
    console.error(`[Discord] Fout bij verzenden: ${error.message}`);
    return false;
  }
}
