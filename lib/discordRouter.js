import { kv } from '@vercel/kv';

// Helper om alles uppercase te maken
const up = (str) => (str ? str.toUpperCase() : "UNKNOWN");

// Bepaal de juiste webhook URL op basis van je Vercel Environment Variables
function getDiscordWebhookForSignal({ source, stage, kind }) {
  if (kind === "trade_opened" || kind === "trade_closed") return process.env.DISCORD_WEBHOOK_TRADE_OPENED;
  if (kind === "alert") return process.env.DISCORD_WEBHOOK_TRADE_ALERTS;

  if (stage === "BUILDUP") return process.env.DISCORD_WEBHOOK_SETUP_WATCH;
  if (stage === "ALMOST" || stage === "ENTRY") return process.env.DISCORD_WEBHOOK_HIGH_ALERT;
  
  // Fallback
  return process.env.DISCORD_WEBHOOK_MARKET_RADAR;
}

// De daadwerkelijke fetch naar Discord
async function sendDiscord(webhookUrl, title, message, color = 3447003) {
  if (!webhookUrl) return false;
  
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [{
          title: title,
          description: message,
          color: color,
          timestamp: new Date().toISOString()
        }]
      })
    });
    return response.ok;
  } catch (error) {
    console.error("[Discord] Netwerkfout bij sturen:", error);
    return false;
  }
}

// Hoofdfunctie die we importeren in api/scan.js
export async function sendSignal(payload) {
  const { source, stage, mode, coin, btcState, kind = "signal" } = payload;
  const st = up(stage || coin?.stage);
  const symbol = up(coin?.symbol);
  
  const webhook = getDiscordWebhookForSignal({ source, stage: st, kind });
  
  console.log(`[Discord Debug] Poging voor ${symbol}: Stage ${st}, Kind ${kind}`);
  
  if (!webhook) {
    console.error(`[Discord Error] GEEN WEBHOOK URL GEVONDEN in Vercel voor kind: ${kind}, stage: ${st}`);
    return false;
  }

  // Deduplicatie (voorkomt spam). ex: 90 betekent 90 seconden geblokkeerd voor dubbele berichten
  if (kind === "trade_opened" || kind === "trade_closed" || kind === "signal") {
    const key = `dedupe:${kind}:${mode}:${symbol}:${st}`;
    try {
      if (process.env.KV_REST_API_URL) {
        const exists = await kv.set(key, "1", { nx: true, ex: 90 });
        if (!exists) {
          console.log(`[Discord] Bericht voor ${symbol} (${st}) overgeslagen (Dedupe / Al verstuurd).`);
          return false;
        }
      }
    } catch (e) {
      console.warn("[KV Error] Dedupe overgeslagen, Vercel KV niet bereikbaar:", e);
    }
  }

  // Maak het bericht op
  const title = `🚨 Update voor ${symbol} | Stage: ${st}`;
  const message = `**Munt:** ${symbol}\n**Status:** ${st}\n**Mode:** ${mode}\n**BTC Status:** ${btcState || "Onbekend"}`;
  
  // Bepaal kleur
  let color = 3447003; // Blauw default
  if (st === "ENTRY") color = 3066993; // Groen
  if (st === "ALMOST") color = 15105570; // Oranje
  
  const result = await sendDiscord(webhook, title, message, color);
  
  if (result) {
    console.log(`[Discord] ✅ Bericht succesvol verzonden voor ${symbol}.`);
  } else {
    console.error(`[Discord] ❌ Fout bij afleveren webhook voor ${symbol}.`);
  }
  
  return result;
}
