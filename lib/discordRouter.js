// lib/discordRouter.js
import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

const up = (str) => (str ? String(str).toUpperCase() : "UNKNOWN");

// =====================================================
// NIEUWE ROUTING (FREE / STARTER / PRO / ELITE)
// =====================================================
function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "main").toLowerCase();
  const st = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // 1. ELITE - execution lifecycle
  if (k === "trade_opened") {
    return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  }
  if (k === "trade_closed") {
    return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;
  }

  // 2. ELITE - pre-trade / trade funnel
  if (
    k === "elite_watch" ||
    k === "pre_trade" ||
    k === "trade_funnel"
  ) {
    return process.env.DISCORD_WEBHOOK_PRE_TRADE;
  }

  // 3. STARTER - losse alerts
  if (k === "alert") {
    return (
      process.env.DISCORD_WEBHOOK_HIGH_ALERT ||
      process.env.DISCORD_WEBHOOK_SETUP_WATCH
    );
  }

  // 4. PRO - trade ready signalen
  if (
    st === "ENTRY" ||
    st === "TRADE_READY" ||
    st === "ELITE_IGNITION" ||
    st === "ELITE_EXPANSION" ||
    st === "ELITE_CASCADE"
  ) {
    return process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
  }

  // 5. STARTER - setup watch
  if (
    st === "ALMOST" ||
    st === "SETUP"
  ) {
    return process.env.DISCORD_WEBHOOK_SETUP_WATCH;
  }

  // 6. FREE - market radar
  if (
    st === "BUILDUP" ||
    st === "WARMUP" ||
    st === "RADAR"
  ) {
    return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }

  // fallback
  return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
}

async function shouldSendDedupe({ kind, symbol, stage, source }) {
  const st = up(stage);
  const isLowTier = (st === "RADAR" || st === "BUILDUP");
  const expiry = isLowTier ? 43200 : 90;
  const key = `dedupe:${kind}:${symbol}:${st}:${source}`;
  if (!process.env.KV_REST_API_URL) return true;
  try {
    const ok = await kv.set(key, "1", { nx: true, ex: expiry });
    return !!ok;
  } catch (e) { return true; }
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

  // =====================================================
  // VERBETERDE TITEL MET DYNAMISCH ICON
  // =====================================================
  let titleIcon = side === "SHORT" ? "🔴" : "🟢";

  if (kind === "trade_closed") {
    titleIcon = Number(pnl) >= 0 ? "✅" : "❌";
  } else if (kind === "trade_opened") {
    titleIcon = "🚀";
  } else if (kind === "elite_watch" || kind === "pre_trade" || kind === "trade_funnel") {
    titleIcon = "🟡";
  }

  const title = `${titleIcon} ${up(kind)} • ${symbol}`;

  return await sendDiscord(webhook, title, message, color);
}