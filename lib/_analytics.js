/* EOF: /lib/_analytics.js */
import { kv } from "@vercel/kv";

const KEEP = 5000;
const EVENTS_KEY = (funnel) => `cc:events:${funnel}:list`;

// Discord webhook mapping
function getDiscordWebhookForFunnel(funnel) {
  switch (String(funnel || "").toLowerCase()) {
    case "scan_entry":
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

// Formatteer Discord bericht op basis van item (met stage-overgang)
function formatDiscordMessage(item) {
  const t = item?.tradePlan || {};
  const mode = String(item?.mode || "").toUpperCase();
  const stage = String(item?.stage || "").toUpperCase();
  const prevStage = String(item?.prevStage || "").toUpperCase();
  const btcState = String(item?.btcState || "-").toUpperCase();

  const moveTxt = prevStage && prevStage !== stage
    ? `${prevStage} → ${stage}`
    : stage;

  return [
    `**${item.symbol || "?"} • ${mode} • ${moveTxt}**`,
    `Prijs: ${fmtNum(item.price)}`,
    `TP: ${fmtNum(t.tp)}`,
    `SL: ${fmtNum(t.sl)}`,
    `Conf: ${item.confidence ?? "-"} • BTC: ${btcState}`,
    `1h: ${fmtNum(item.change1h, 3)}% • 24h: ${fmtNum(item.change24, 3)}% • RR: ${fmtNum(t.rr, 2)}`,
  ].join("\n");
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

  // Opslag in KV (bestaande logica)
  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(event));
    await kv.ltrim(key, 0, KEEP - 1);
  } else {
    const prev = (await kv.get(key)) || [];
    const arr = Array.isArray(prev) ? prev : [];
    arr.unshift(event);
    await kv.set(key, arr.slice(0, KEEP));
  }

  // Stuur naar Discord indien webhook bekend
  try {
    const webhook = getDiscordWebhookForFunnel(funnel);
    if (webhook) {
      const content = formatDiscordMessage(eventData); // gebruik het originele item (zonder id/ts)
      await postToDiscord(webhook, content);
    }
  } catch (discordErr) {
    // negeer Discord fouten, alleen loggen indien gewenst
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