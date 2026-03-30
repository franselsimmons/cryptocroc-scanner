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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------------------
// Cooldown (per source+stage)
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

// -------------------------------
// Global dedupe (main+moon samen)
// -> voorkomt dubbele trade_opened / trade_closed meldingen
// -------------------------------
function globalDedupeKey({ mode, symbol, kind }) {
  return [
    "discord",
    "dedupe",
    String(kind || "signal").toLowerCase(),
    String(mode || "").toLowerCase(),
    up(symbol),
  ].join(":");
}

function sourceRank(source) {
  const s = String(source || "").toLowerCase();
  if (s === "main") return 2;
  if (s === "moon") return 1;
  return 0;
}

function shouldGlobalDedupe(kind) {
  const k = String(kind || "signal").toLowerCase();
  return k === "trade_opened" || k === "trade_closed";
}

async function acquireGlobalDedupe({ source, mode, symbol, kind, ttlSec }) {
  const key = globalDedupeKey({ mode, symbol, kind });
  const now = Date.now();

  // Probeer lock te pakken
  const ok = await kv.set(
    key,
    { ts: now, source: String(source || "").toLowerCase() },
    { nx: true, ex: ttlSec }
  );
  if (ok) return { ok: true, key };

  // Bestaat al -> skip
  const cur = await kv.get(key);
  return { ok: false, key, cur };
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

  return src === "moon" && (s === "ELITE_IGNITION" || s === "ELITE_EXPANSION");
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
  const ok = await kv.set(key, { ts: Date.now() }, { nx: true, ex: cooldownSec });
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

function getGlobalDedupeTtlSec(kind) {
  // korte window om dubbele MAIN/MOON open/close te voorkomen
  // default 90 sec
  const k = String(kind || "").toLowerCase();
  if (k === "trade_opened") return n(process.env.DISCORD_DEDUPE_TRADE_OPENED_SEC, 90);
  if (k === "trade_closed") return n(process.env.DISCORD_DEDUPE_TRADE_CLOSED_SEC, 90);
  return n(process.env.DISCORD_DEDUPE_SEC, 90);
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

  const k = String(kind || "signal").toLowerCase();
  const src = String(source || "").toLowerCase();

  // -------------------------------------------------------
  // GLOBAL DEDUPE: voorkom dubbele MAIN/MOON open/close
  // MAIN krijgt "voorrang" door MOON mini-delay + recheck
  // -------------------------------------------------------
  if (shouldGlobalDedupe(k)) {
    const ttlSec = getGlobalDedupeTtlSec(k);

    // Geef MAIN een grotere kans om als eerste te locken
    // (MOON wacht een tikje als beide tegelijk afgaan)
    const moonDelayMs = n(process.env.DISCORD_DEDUPE_MOON_DELAY_MS, 900);
    if (src === "moon" && moonDelayMs > 0) {
      await sleep(moonDelayMs);
    }

    const g = await acquireGlobalDedupe({
      source,
      mode,
      symbol,
      kind: k,
      ttlSec,
    });

    if (!g.ok) {
      // Als er al iets is, skip.
      // (Hier geen override -> want we kunnen het eerdere bericht niet intrekken)
      return false;
    }
  }

  // -------------------------------------------------------
  // PER-SOURCE/STAGE COOLDOWN (zoals je al had)
  // -------------------------------------------------------
  const cooldownSec = getCooldownSec({ source, stage, kind });

  const allowed = await shouldSendWithCooldown({
    source,
    mode,
    stage,
    symbol,
    kind,
    cooldownSec,
  });

  if (!allowed) return false;

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