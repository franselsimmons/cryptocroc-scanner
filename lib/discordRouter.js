// lib/discordRouter.js
import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

const up = (str) => (str ? String(str).toUpperCase() : "UNKNOWN");

function getDiscordWebhookForSignal({ stage, kind }) {
  const st = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // ELITE - execution lifecycle
  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;

  // ELITE - tunnel watch
  if (k === "elite_watch" || k === "watch" || k === "trade_funnel") {
    return process.env.DISCORD_WEBHOOK_PRE_TRADE;
  }

  // STARTER - losse alerts
  if (k === "alert") {
    return (
      process.env.DISCORD_WEBHOOK_HIGH_ALERT ||
      process.env.DISCORD_WEBHOOK_SETUP_WATCH
    );
  }

  // PRO - scanner trade ready
  if (st === "ENTRY" || st === "TRADE_READY") {
    return process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
  }

  // STARTER - scanner almost/setup
  if (st === "ALMOST" || st === "SETUP") {
    return process.env.DISCORD_WEBHOOK_SETUP_WATCH;
  }

  // FREE - scanner early phase
  if (st === "BUILDUP" || st === "WARMUP" || st === "RADAR") {
    return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }

  return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
}

async function shouldSendDedupe({ kind, symbol, stage, source }) {
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
  const side = up(coin?.side);
  const kindKey = String(kind || "signal").toLowerCase();

  if (!symbol || symbol === "UNKNOWN") return false;

  const webhook = getDiscordWebhookForSignal({ stage, kind: kindKey });
  if (!webhook) return false;

  if (!(await shouldSendDedupe({ kind: kindKey, symbol, stage, source }))) {
    return false;
  }

  const message = formatSignalMessage({
    source,
    stage,
    kind: kindKey,
    coin,
    pnl,
  });

  const color = getDiscordColor({ kind: kindKey, pnl });

  let titleIcon = side === "SHORT" ? "🔴" : "🟢";

  if (kindKey === "trade_closed") {
    titleIcon = Number(pnl) >= 0 ? "✅" : "❌";
  } else if (kindKey === "trade_opened") {
    titleIcon = "🚀";
  } else if (
    kindKey === "elite_watch" ||
    kindKey === "watch" ||
    kindKey === "trade_funnel"
  ) {
    titleIcon = "🟡";
  }

  const title = `${titleIcon} ${up(kindKey)} • ${symbol}`;

  return await sendDiscord(webhook, title, message, color);
}