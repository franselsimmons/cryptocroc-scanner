// lib/discordRouter.js
import { kv } from "@vercel/kv";
import { sendDiscord } from "./sendDiscord.js";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}
function up(x) {
  return String(x || "").toUpperCase();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------------------
// Keys
// -------------------------------
function cooldownKey({ source, mode, stage, symbol, kind }) {
  return [
    "discord",
    "cooldown",
    String(kind || "signal").toLowerCase(),
    String(source || "").toLowerCase(),
    String(mode || "").toLowerCase(),
    up(stage),
    up(symbol),
  ].join(":");
}

function globalDedupeKey({ mode, symbol, kind }) {
  return [
    "discord",
    "dedupe",
    String(kind || "signal").toLowerCase(),
    String(mode || "").toLowerCase(),
    up(symbol),
  ].join(":");
}

// ✅ NEW: inflight lock (voorkomt “double send tegelijk”, maar blokkeert geen retries)
function inflightKey({ mode, symbol, kind }) {
  return [
    "discord",
    "inflight",
    String(kind || "signal").toLowerCase(),
    String(mode || "").toLowerCase(),
    up(symbol),
  ].join(":");
}

function shouldGlobalDedupe(kind) {
  const k = String(kind || "signal").toLowerCase();
  return k === "trade_opened" || k === "trade_closed";
}

// -------------------------------
// Stage helpers
// -------------------------------
function isMainProStage(source, stage) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  return src === "main" && (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE");
}
function isMoonProStage(source, stage) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  return src === "moon" && (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION");
}

// -------------------------------
// Webhook router
// -------------------------------
export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // nooit sturen
  if (k === "portfolio") return null;
  if (k === "position_update") return null;

  // ELITE — Trade Desk
  if (k === "elite_watch") return process.env.DISCORD_WEBHOOK_PRE_TRADE || null;

  if (k === "trade_opened") return process.env.DISCORD_WEBHOOK_TRADE_OPENED || null;
  if (k === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_CLOSED || null;

  if (k === "signal") {
    // FREE — BUILDUP
    if (s === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH || null;

    // STARTER — ALMOST
    if (s === "ALMOST") return process.env.DISCORD_WEBHOOK_HIGH_ALERT || null;

    // PRO — elite stages
    if (isMainProStage(src, s) || isMoonProStage(src, s)) {
      return process.env.DISCORD_WEBHOOK_TRADE_ALERTS || null;
    }

    // radar optioneel
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

// -------------------------------
// Cooldowns
// -------------------------------
function getCooldownSec({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

  if (k === "trade_opened") return n(process.env.DISCORD_COOLDOWN_TRADE_OPENED_SEC, 1800);
  if (k === "trade_closed") return n(process.env.DISCORD_COOLDOWN_TRADE_CLOSED_SEC, 1800);
  if (k === "position_update") return n(process.env.DISCORD_COOLDOWN_POSITION_UPDATE_SEC, 900);
  if (k === "portfolio") return n(process.env.DISCORD_COOLDOWN_PORTFOLIO_SEC, 900);
  if (k === "elite_watch") return n(process.env.DISCORD_COOLDOWN_PRE_TRADE_SEC, 10800);

  if (k === "signal") {
    if (isMainProStage(src, s)) return n(process.env.DISCORD_COOLDOWN_MAIN_ENTRY_SEC, 7200);
    if (isMoonProStage(src, s)) return n(process.env.DISCORD_COOLDOWN_MOON_ELITE_SEC, 7200);

    if (s === "ALMOST") {
      if (src === "moon") return n(process.env.DISCORD_COOLDOWN_MOON_ALMOST_SEC, 10800);
      return n(process.env.DISCORD_COOLDOWN_ALMOST_SEC, 10800);
    }

    if (s === "BUILDUP") {
      if (src === "moon") return n(process.env.DISCORD_COOLDOWN_MOON_BUILDUP_SEC, 14400);
      return n(process.env.DISCORD_COOLDOWN_BUILDUP_SEC, 14400);
    }

    if (s === "RADAR") {
      if (src === "moon") return n(process.env.DISCORD_COOLDOWN_MOON_RADAR_SEC, 21600);
      return n(process.env.DISCORD_COOLDOWN_RADAR_SEC, 21600);
    }
  }

  return 7200;
}

function getGlobalDedupeTtlSec(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "trade_opened") return n(process.env.DISCORD_DEDUPE_TRADE_OPENED_SEC, 90);
  if (k === "trade_closed") return n(process.env.DISCORD_DEDUPE_TRADE_CLOSED_SEC, 90);
  return n(process.env.DISCORD_DEDUPE_SEC, 90);
}

// -------------------------------
// Core send
// -------------------------------
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

  const k = String(kind || "signal").toLowerCase();
  const src = String(source || "").toLowerCase();

  // ✅ 1) GLOBAL DEDUPE CHECK (alleen checken, NIET “locken”)
  if (shouldGlobalDedupe(k)) {
    const key = globalDedupeKey({ mode, symbol, kind: k });
    const cur = await kv.get(key);
    if (cur) {
      // er is al een succesvol bericht geweest in het dedupe-window
      return false;
    }
  }

  // ✅ 2) COOLDOWN CHECK (alleen checken, NIET “locken”)
  const cdKey = cooldownKey({ source, mode, stage, symbol, kind });
  const hasCooldown = await kv.get(cdKey);
  if (hasCooldown) return false;

  // ✅ 3) INFLIGHT lock (voorkomt gelijktijdige dubbele posts)
  const inflight = inflightKey({ mode, symbol, kind: k });

  // MAIN vs MOON: moon mini-delay (zoals je wilde)
  const moonDelayMs = n(process.env.DISCORD_DEDUPE_MOON_DELAY_MS, 900);
  if (src === "moon" && shouldGlobalDedupe(k) && moonDelayMs > 0) {
    await sleep(moonDelayMs);
  }

  const inflightOk = await kv.set(
    inflight,
    { ts: Date.now(), source: src },
    { nx: true, ex: 30 } // 30s “inflight window”
  );
  if (!inflightOk) return false;

  try {
    const message = formatSignalMessage({
      source,
      stage,
      mode,
      coin,
      btcState,
      kind: k,
      pnl,
      reason,
    });

    const title = `${String(source || "").toUpperCase()} ${up(stage)} • ${symbol}`;

    const color = getDiscordColor({ kind: k, pnl, reason });

    // ✅ 4) SEND to Discord (met retries in sendDiscord)
    const ok = await sendDiscord(webhook, title, message, color);

    if (!ok) return false;

    // ✅ 5) PAS NU cooldown zetten (want send is succesvol)
    const cooldownSec = getCooldownSec({ source, stage, kind: k });
    await kv.set(cdKey, { ts: Date.now() }, { ex: cooldownSec });

    // ✅ 6) PAS NU global dedupe zetten (want send is succesvol)
    if (shouldGlobalDedupe(k)) {
      const ttlSec = getGlobalDedupeTtlSec(k);
      const gKey = globalDedupeKey({ mode, symbol, kind: k });
      await kv.set(gKey, { ts: Date.now(), source: src }, { ex: ttlSec });
    }

    return true;
  } finally {
    // ✅ inflight altijd opruimen zodat retries mogelijk blijven
    try {
      await kv.del(inflight);
    } catch {}
  }
}