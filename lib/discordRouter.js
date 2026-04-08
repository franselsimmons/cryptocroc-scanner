// lib/discordRouter.js
import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

const up = (str) => (str ? String(str).toUpperCase() : "UNKNOWN");

function getDiscordWebhookForSignal({ stage, kind, source, coin }) {
  const st = up(stage);
  const k = String(kind || "signal").toLowerCase();
  const src = String(source || "").toLowerCase();
  const gate = up(coin?.scannerGate || coin?.tradeDeskStatus || "");

  // ======================================================
  // EXECUTION LIFECYCLE
  // ======================================================
  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED;

  // ======================================================
  // WATCH / FUNNEL
  // ======================================================
  if (k === "elite_watch" || k === "watch" || k === "trade_funnel") {
    // Main WATCH mag expliciet ook naar pre-trade
    if (src === "main") {
      return (
        process.env.DISCORD_WEBHOOK_PRE_TRADE ||
        process.env.DISCORD_WEBHOOK_TRADE_ALERTS
      );
    }

    return process.env.DISCORD_WEBHOOK_PRE_TRADE;
  }

  // ======================================================
  // LOSSE ALERTS
  // ======================================================
  if (k === "alert") {
    return (
      process.env.DISCORD_WEBHOOK_HIGH_ALERT ||
      process.env.DISCORD_WEBHOOK_SETUP_WATCH
    );
  }

  // ======================================================
  // MAIN PRIORITEIT
  // ======================================================
  if (src === "main") {
    // Alles wat effectief WATCH is, moet naar pre-trade / setup
    if (gate === "WATCH") {
      if (st === "TRADE_READY" || st === "ENTRY") {
        return (
          process.env.DISCORD_WEBHOOK_TRADE_ALERTS ||
          process.env.DISCORD_WEBHOOK_PRE_TRADE
        );
      }

      if (st === "ALMOST" || st === "BUILDUP") {
        return (
          process.env.DISCORD_WEBHOOK_PRE_TRADE ||
          process.env.DISCORD_WEBHOOK_SETUP_WATCH
        );
      }

      return (
        process.env.DISCORD_WEBHOOK_PRE_TRADE ||
        process.env.DISCORD_WEBHOOK_MARKET_RADAR
      );
    }

    // Main TRADE_READY / ENTRY
    if (st === "ENTRY" || st === "TRADE_READY") {
      return (
        process.env.DISCORD_WEBHOOK_TRADE_ALERTS ||
        process.env.DISCORD_WEBHOOK_PRE_TRADE
      );
    }

    // Main ALMOST = setup/watch
    if (st === "ALMOST" || st === "SETUP") {
      return (
        process.env.DISCORD_WEBHOOK_SETUP_WATCH ||
        process.env.DISCORD_WEBHOOK_PRE_TRADE
      );
    }

    // Main BUILDUP / RADAR = radar
    if (st === "BUILDUP" || st === "WARMUP" || st === "RADAR") {
      return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
    }
  }

  // ======================================================
  // DEFAULT / MOON / OVERIGE FLOW
  // ======================================================
  if (st === "ENTRY" || st === "TRADE_READY") {
    return process.env.DISCORD_WEBHOOK_TRADE_ALERTS;
  }

  if (st === "ALMOST" || st === "SETUP") {
    return process.env.DISCORD_WEBHOOK_SETUP_WATCH;
  }

  if (st === "BUILDUP" || st === "WARMUP" || st === "RADAR") {
    return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
  }

  return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
}

async function shouldSendDedupe({ kind, symbol, stage, source }) {
  const st = up(stage);
  const src = String(source || "unknown").toLowerCase();

  // main mag sneller opnieuw sturen dan moon op lagere tiers
  const isLowTier = st === "RADAR" || st === "BUILDUP";
  const isMain = src === "main";

  const expiry = isLowTier
    ? isMain
      ? 7200
      : 43200
    : 90;

  const key = `dedupe:${kind}:${symbol}:${st}:${src}`;

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

  const webhook = getDiscordWebhookForSignal({
    stage,
    kind: kindKey,
    source,
    coin,
  });

  if (!webhook) return false;

  if (
    !(await shouldSendDedupe({
      kind: kindKey,
      symbol,
      stage,
      source,
    }))
  ) {
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

  const srcLabel = String(source || "").toLowerCase() === "main" ? "MAIN" : up(source);
  const title = `${titleIcon} ${srcLabel} • ${up(kindKey)} • ${symbol}`;

  return await sendDiscord(webhook, title, message, color);
}

export default {
  sendSignal,
};