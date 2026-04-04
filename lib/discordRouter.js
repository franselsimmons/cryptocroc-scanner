import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

const up = (x) => String(x || "").toUpperCase();

// Webhook mapping EXACT op basis van jouw Vercel screenshots
export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

  if (k === "portfolio") return process.env.DISCORD_WEBHOOK_PORTFOLIO;
  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;
  if (k === "elite_watch" || k === "pre_trade") return process.env.DISCORD_WEBHOOK_PRE_TRADE;

  if (k === "signal") {
    if (s === "RADAR") {
      return (src === "moon" ? process.env.DISCORD_WEBHOOK_RADAR_MOON : null) || process.env.DISCORD_WEBHOOK_MARKET_RADAR;
    }
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH;
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_HIGH_ALERT;
    
    // Alles wat richting entry gaat
    const entryStages = ["ENTRY", "TRADE_READY", "OPEN", "ELITE_IGNITION", "ELITE_EXPANSION", "ELITE_CASCADE"];
    if (entryStages.includes(s)) return process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
    
    return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }
  return null;
}

export async function sendSignal({ source, stage, mode, coin, btcState, kind = "signal", pnl, reason }) {
  const st = up(stage || coin?.stage || "UNKNOWN");
  const webhook = getDiscordWebhookForSignal({ source, stage: st, kind });
  
  if (!webhook || !coin?.symbol) return false;

  // Global Dedupe (voorkom dubbele Main/Moon meldingen voor geopende trades)
  if (kind === "trade_opened" || kind === "trade_closed") {
    const key = `dedupe:${kind}:${mode}:${coin.symbol.toUpperCase()}`;
    const exists = await kv.set(key, "1", { nx: true, ex: 90 });
    if (!exists && source === "moon") return false; // Main kreeg voorrang
  }

  const message = formatSignalMessage({ source, stage: st, mode, coin, btcState, kind, pnl, reason });
  const title = `${up(source)} ${st} • ${up(coin.symbol)}`;
  const color = getDiscordColor({ kind, pnl, reason });

  return await sendDiscord(webhook, title, message, color);
}
