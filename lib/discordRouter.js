// lib/discordRouter.js
// FIXED: correct webhook mapping + ENTRY routing + MOON elite cascade + color usage + logs

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

function debugEnabled() {
  return String(process.env.DISCORD_DEBUG || "").trim() === "1";
}
function dlog(...args) {
  if (debugEnabled()) console.log("[discord]", ...args);
}

// --------------------------------
// Cooldown (per source+stage+symbol+kind)
// --------------------------------
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

// --------------------------------
// Global dedupe: prevent double MAIN/MOON trade_opened/closed
// --------------------------------
function globalDedupeKey({ mode, symbol, kind }) {
  return [
    "discord",
    "dedupe",
    String(kind || "signal").toLowerCase(),
    String(mode || "").toLowerCase(),
    up(symbol),
  ].join(":");
}

function shouldGlobalDedupe(kind) {
  const k = String(kind || "signal").toLowerCase();
  return k === "trade_opened" || k === "trade_closed";
}

async function acquireGlobalDedupe({ source, mode, symbol, kind, ttlSec }) {
  const key = globalDedupeKey({ mode, symbol, kind });
  const now = Date.now();

  const ok = await kv.set(
    key,
    { ts: now, source: String(source || "").toLowerCase() },
    { nx: true, ex: ttlSec }
  );

  if (ok) return { ok: true, key };

  const cur = await kv.get(key);
  return { ok: false, key, cur };
}

function getGlobalDedupeTtlSec(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "trade_opened") return n(process.env.DISCORD_DEDUPE_TRADE_OPENED_SEC, 90);
  if (k === "trade_closed") return n(process.env.DISCORD_DEDUPE_TRADE_CLOSED_SEC, 90);
  return n(process.env.DISCORD_DEDUPE_SEC, 90);
}

// --------------------------------
// Stage helpers
// --------------------------------
function isMainProStage(source, stage) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  return src === "main" && (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE");
}
function isMoonProStage(source, stage) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  // ✅ FIX: include ELITE_CASCADE (moon bear kan cascade hebben)
  return src === "moon" && (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE");
}

// --------------------------------
// ENV resolver: supports BOTH naming schemes
// --------------------------------
function envFirst(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v && String(v).trim()) return String(v).trim();
  }
  return null;
}

export function getDiscordWebhookForSignal({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // never
  if (k === "portfolio") return null;
  if (k === "position_update") return null;

  // ELITE execution engine channels
  if (k === "elite_watch") {
    return envFirst("DISCORD_WEBHOOK_PRE_TRADE", "DISCORD_WEBHOOK_ELITE");
  }

  if (k === "trade_opened") {
    return envFirst("DISCORD_WEBHOOK_TRADE_OPENED");
  }

  if (k === "trade_closed") {
    return envFirst("DISCORD_WEBHOOK_TRADE_CLOSED");
  }

  // Scannerflow signals
  if (k === "signal") {
    // ✅ FIX: ENTRY stage bestond niet -> daarom geen entry meldingen
    // ENTRY/OPEN sturen naar Trade Alerts (PRO kanaal)
    if (s === "ENTRY" || s === "OPEN") {
      return envFirst("DISCORD_WEBHOOK_TRADE_ALERTS", "DISCORD_WEBHOOK_ELITE");
    }

    // BUILDUP (Setup Watch)
    if (s === "BUILDUP") {
      if (src === "moon") {
        return envFirst("DISCORD_WEBHOOK_BUILDUP_MOON", "DISCORD_WEBHOOK_SETUP_WATCH");
      }
      return envFirst("DISCORD_WEBHOOK_BUILDUP", "DISCORD_WEBHOOK_SETUP_WATCH");
    }

    // ALMOST (High Alert)
    if (s === "ALMOST") {
      if (src === "moon") {
        return envFirst("DISCORD_WEBHOOK_ALMOST_MOON", "DISCORD_WEBHOOK_HIGH_ALERT");
      }
      return envFirst("DISCORD_WEBHOOK_ALMOST", "DISCORD_WEBHOOK_HIGH_ALERT");
    }

    // PRO (elite stages)
    if (isMainProStage(src, s) || isMoonProStage(src, s)) {
      return envFirst("DISCORD_WEBHOOK_TRADE_ALERTS", "DISCORD_WEBHOOK_ELITE");
    }

    // RADAR (Market radar)
    if (s === "RADAR") {
      if (src === "moon") {
        return envFirst("DISCORD_WEBHOOK_RADAR_MOON", "DISCORD_WEBHOOK_MARKET_RADAR", "DISCORD_WEBHOOK_RADAR");
      }
      return envFirst("DISCORD_WEBHOOK_MARKET_RADAR", "DISCORD_WEBHOOK_RADAR");
    }
  }

  return null;
}

// --------------------------------
// Cooldown
// --------------------------------
async function shouldSendWithCooldown({ source, mode, stage, symbol, kind, cooldownSec }) {
  const key = cooldownKey({ source, mode, stage, symbol, kind });
  const ok = await kv.set(key, { ts: Date.now() }, { nx: true, ex: cooldownSec });
  return !!ok;
}

function getCooldownSec({ source, stage, kind }) {
  const src = String(source || "").toLowerCase();
  const s = up(stage);
  const k = String(kind || "signal").toLowerCase();

  if (k === "trade_opened") return n(process.env.DISCORD_COOLDOWN_TRADE_OPENED_SEC, 1800);
  if (k === "trade_closed") return n(process.env.DISCORD_COOLDOWN_TRADE_CLOSED_SEC, 1800);
  if (k === "elite_watch") return n(process.env.DISCORD_COOLDOWN_PRE_TRADE_SEC, 10800);

  if (k === "signal") {
    // PRO
    if (isMainProStage(src, s)) return n(process.env.DISCORD_COOLDOWN_MAIN_ENTRY_SEC, 7200);
    if (isMoonProStage(src, s)) return n(process.env.DISCORD_COOLDOWN_MOON_ELITE_SEC, 7200);

    // ENTRY meldingen wil je meestal niet te hard throttlen
    if (s === "ENTRY" || s === "OPEN") return n(process.env.DISCORD_COOLDOWN_ENTRY_SEC, 900);

    // ALMOST
    if (s === "ALMOST") {
      if (src === "moon") return n(process.env.DISCORD_COOLDOWN_MOON_ALMOST_SEC, 10800);
      return n(process.env.DISCORD_COOLDOWN_ALMOST_SEC, 10800);
    }

    // BUILDUP
    if (s === "BUILDUP") {
      if (src === "moon") return n(process.env.DISCORD_COOLDOWN_MOON_BUILDUP_SEC, 14400);
      return n(process.env.DISCORD_COOLDOWN_BUILDUP_SEC, 14400);
    }

    // RADAR
    if (s === "RADAR") {
      if (src === "moon") return n(process.env.DISCORD_COOLDOWN_MOON_RADAR_SEC, 21600);
      return n(process.env.DISCORD_COOLDOWN_RADAR_SEC, 21600);
    }
  }

  return 7200;
}

// --------------------------------
// Main entry point
// --------------------------------
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
  const src = String(source || "").toLowerCase();
  const k = String(kind || "signal").toLowerCase();

  const st = up(stage || coin?.stage || "UNKNOWN");

  const webhook = getDiscordWebhookForSignal({ source: src, stage: st, kind: k });
  if (!webhook) {
    dlog("SKIP:no_webhook", { source: src, stage: st, kind: k });
    return false;
  }

  const symbol = coin?.symbol;
  if (!symbol) {
    dlog("SKIP:no_symbol", { source: src, stage: st, kind: k });
    return false;
  }

  // GLOBAL DEDUPE (open/close)
  if (shouldGlobalDedupe(k)) {
    const ttlSec = getGlobalDedupeTtlSec(k);
    const moonDelayMs = n(process.env.DISCORD_DEDUPE_MOON_DELAY_MS, 900);
    if (src === "moon" && moonDelayMs > 0) await sleep(moonDelayMs);

    const g = await acquireGlobalDedupe({ source: src, mode, symbol, kind: k, ttlSec });
    if (!g.ok) {
      dlog("SKIP:dedupe", { source: src, stage: st, kind: k, symbol, cur: g.cur || null });
      return false;
    }
  }

  // COOLDOWN
  const cooldownSec = getCooldownSec({ source: src, stage: st, kind: k });
  const allowed = await shouldSendWithCooldown({
    source: src,
    mode,
    stage: st,
    symbol,
    kind: k,
    cooldownSec,
  });

  if (!allowed) {
    dlog("SKIP:cooldown", { source: src, stage: st, kind: k, symbol, cooldownSec });
    return false;
  }

  // MESSAGE + COLOR
  const message = formatSignalMessage({
    source: src,
    stage: st,
    mode,
    coin,
    btcState,
    kind: k,
    pnl,
    reason,
  });

  const title = `${up(src)} ${st} • ${up(symbol)}`;
  const color = getDiscordColor({ kind: k, pnl, reason });

  // SEND
  await sendDiscord(webhook, title, message, color);
  dlog("SEND:ok", { source: src, stage: st, kind: k, symbol });
  return true;
}