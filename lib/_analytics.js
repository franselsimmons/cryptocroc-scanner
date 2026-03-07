import { kv } from "@vercel/kv";

const KEEP = 5000;
const EVENTS_KEY = (funnel) => `cc:events:${funnel}:list`;

// 10 minuten anti-spam per funnel/mode/symbol/stage
const DISCORD_DEDUPE_TTL_SEC = 10 * 60;

// Discord webhook mapping
function getDiscordWebhookForFunnel(funnel) {
  switch (String(funnel || "").toLowerCase()) {
    case "scan_entry":
    case "scan_hold":
    case "scan_sell":
      return process.env.DISCORD_WEBHOOK_ELITE || "";
    case "scan_almost":
      return process.env.DISCORD_WEBHOOK_ALMOST || "";
    case "scan_buildup":
      return process.env.DISCORD_WEBHOOK_BUILDUP || "";
    case "scan_radar":
      return process.env.DISCORD_WEBHOOK_RADAR || "";
    default:
      return "";
  }
}

// Helper voor formatteren van getallen
function fmtNum(x, max = 8) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(max).replace(/\.?0+$/, "");
}

function escapeDiscord(text) {
  return String(text || "").replace(/([\\_*~`|>])/g, "\\$1");
}

function discordDedupeKey(funnel, item) {
  const symbol = String(item?.symbol || "").toUpperCase();
  const stage = String(item?.stage || funnel || "").toUpperCase();
  const mode = String(item?.mode || "").toUpperCase();
  return `cc:discord:dedupe:${String(funnel || "").toLowerCase()}:${mode}:${symbol}:${stage}`;
}

async function shouldSendDiscord(funnel, item) {
  const key = discordDedupeKey(funnel, item);

  const payload = {
    symbol: String(item?.symbol || "").toUpperCase(),
    stage: String(item?.stage || "").toUpperCase(),
    mode: String(item?.mode || "").toUpperCase(),
    reason: String(item?.reason || ""),
    price: Number(item?.price || 0),
  };

  const prev = await kv.get(key);

  if (prev && typeof prev === "object") {
    const sameReason = String(prev.reason || "") === payload.reason;
    const sameStage = String(prev.stage || "") === payload.stage;
    const sameMode = String(prev.mode || "") === payload.mode;
    const sameSymbol = String(prev.symbol || "") === payload.symbol;

    const prevPrice = Number(prev.price || 0);
    const curPrice = Number(payload.price || 0);
    const priceDriftPct =
      prevPrice > 0 && curPrice > 0
        ? Math.abs((curPrice - prevPrice) / prevPrice) * 100
        : 0;

    if (sameSymbol && sameStage && sameMode && sameReason && priceDriftPct < 0.35) {
      return false;
    }
  }

  await kv.set(key, payload, { ex: DISCORD_DEDUPE_TTL_SEC });
  return true;
}

function getSellOutcome(item) {
  const reason = String(item?.reason || item?.exitReason || "").toLowerCase();

  if (reason.includes("tp")) {
    return { label: "TP HIT", emoji: "✅" };
  }
  if (reason.includes("sl") || reason.includes("stop")) {
    return { label: "SL HIT", emoji: "🛑" };
  }
  return { label: "EXIT SIGNAL", emoji: "⚠️" };
}

// Formatteer Discord bericht op basis van funnel + item
function formatDiscordMessage(funnel, item) {
  const t = item?.tradePlan || {};
  const mode = String(item?.mode || "").toUpperCase();
  const stage = String(item?.stage || "").toUpperCase();
  const prevStage = String(item?.prevStage || "").toUpperCase();
  const btcState = String(item?.btcState || "-").toUpperCase();

  const moveTxt =
    prevStage && prevStage !== stage
      ? `${prevStage} → ${stage}`
      : stage || "-";

  const symbol = item?.symbol || "?";
  const price = fmtNum(item?.price);
  const tp = fmtNum(t?.tp);
  const sl = fmtNum(t?.sl);
  const rr = fmtNum(t?.rr, 2);
  const conf = item?.confidence ?? "-";
  const ch1h = `${fmtNum(item?.change1h, 3)}%`;
  const ch24 = `${fmtNum(item?.change24, 3)}%`;
  const spread = fmtNum(item?.ob?.spreadPct, 3);
  const depth = fmtNum(item?.ob?.depthMinUsd1p, 0);
  const obScore = fmtNum(item?.ob?.score, 5);
  const reasonTxt = escapeDiscord(item?.reason || "-");

  switch (String(funnel || "").toLowerCase()) {
    case "scan_buildup":
      return [
        `🟡 **${escapeDiscord(symbol)} • ${mode} • ${escapeDiscord(moveTxt)}**`,
        `Prijs: ${price}`,
        `TP: ${tp}`,
        `SL: ${sl}`,
      ].join("\n");

    case "scan_almost":
      return [
        `🟠 **${escapeDiscord(symbol)} • ${mode} • ${escapeDiscord(moveTxt)}**`,
        `Prijs: ${price}`,
        `TP: ${tp}`,
        `SL: ${sl}`,
        `Conf: ${conf} • BTC: ${btcState}`,
        `1h: ${ch1h} • 24h: ${ch24} • RR: ${rr}`,
      ].join("\n");

    case "scan_entry":
      return [
        `🚨 **${escapeDiscord(symbol)} • ${mode} • ${escapeDiscord(moveTxt)}**`,
        `Prijs: ${price}`,
        `TP: ${tp}`,
        `SL: ${sl}`,
        `Conf: ${conf} • BTC: ${btcState}`,
        `1h: ${ch1h} • 24h: ${ch24} • RR: ${rr}`,
        `Spread: ${spread}% • Depth: ${depth} • OB: ${obScore}`,
      ].join("\n");

    case "scan_hold":
      return [
        `🟢 **${escapeDiscord(symbol)} • ${mode} • ${escapeDiscord(moveTxt)}**`,
        `Prijs: ${price}`,
        `TP: ${tp}`,
        `SL: ${sl}`,
        `Conf: ${conf} • BTC: ${btcState}`,
        `1h: ${ch1h} • 24h: ${ch24} • RR: ${rr}`,
        `Status: HOLD`,
      ].join("\n");

    case "scan_sell": {
      const outcome = getSellOutcome(item);
      return [
        `${outcome.emoji} **${escapeDiscord(symbol)} • ${mode} • ${escapeDiscord(moveTxt)}**`,
        `Status: ${outcome.label}`,
        `Exit prijs: ${price}`,
        `TP: ${tp}`,
        `SL: ${sl}`,
        `Conf: ${conf} • BTC: ${btcState}`,
        `1h: ${ch1h} • 24h: ${ch24} • RR: ${rr}`,
        `Reason: ${reasonTxt}`,
      ].join("\n");
    }

    case "scan_radar":
      return [
        `🔵 **${escapeDiscord(symbol)} • ${mode} • ${escapeDiscord(moveTxt)}**`,
        `Prijs: ${price}`,
        `Conf: ${conf} • BTC: ${btcState}`,
        `1h: ${ch1h} • 24h: ${ch24}`,
      ].join("\n");

    default:
      return [
        `**${escapeDiscord(symbol)} • ${mode} • ${escapeDiscord(moveTxt)}**`,
        `Prijs: ${price}`,
        `TP: ${tp}`,
        `SL: ${sl}`,
        `Conf: ${conf} • BTC: ${btcState}`,
        `1h: ${ch1h} • 24h: ${ch24} • RR: ${rr}`,
        `Reason: ${reasonTxt}`,
      ].join("\n");
  }
}

// Stuur bericht naar Discord met foutcontrole
async function postToDiscord(webhook, content) {
  if (!webhook || !content) return;

  const r = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Discord ${r.status}: ${txt.slice(0, 200)}`);
  }
}

export function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

export async function pushEvent(funnel, eventData) {
  const key = EVENTS_KEY(funnel);
  const event = {
    id: uid("evt"),
    ts: Date.now(),
    ...eventData,
  };

  // Opslag in KV
  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(event));
    await kv.ltrim(key, 0, KEEP - 1);
  } else {
    const prev = (await kv.get(key)) || [];
    const arr = Array.isArray(prev) ? prev : [];
    arr.unshift(event);
    await kv.set(key, arr.slice(0, KEEP));
  }

  // Discord met dedupe
  try {
    const webhook = getDiscordWebhookForFunnel(funnel);
    if (webhook) {
      const allowDiscord = await shouldSendDiscord(funnel, event);
      if (allowDiscord) {
        const content = formatDiscordMessage(funnel, event);
        await postToDiscord(webhook, content);
      }
    }
  } catch (discordErr) {
    console.error("Discord notification failed:", discordErr);
  }

  return event.id;
}

export async function readEvents(funnel, limit = 2000) {
  const key = EVENTS_KEY(funnel);
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(key, 0, Math.max(0, limit - 1));
      return (raw || [])
        .map((x) => {
          try {
            return typeof x === "string" ? JSON.parse(x) : x;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
  } catch {}

  const data = await kv.get(key);
  return Array.isArray(data) ? data.slice(0, limit) : [];
}