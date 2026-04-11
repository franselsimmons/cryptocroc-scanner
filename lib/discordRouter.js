import { kv } from "@vercel/kv";
import { formatSignalMessage, getDiscordColor } from "./formatDiscord.js"; // Indien aanwezig
// Of vereenvoudigd via REST
async function sendDiscord(webhookUrl, title, message) {
  try {
      await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `**${title}**\n${message}` })
      });
  } catch(e) { }
}

export async function startDiscordQueueProcessor() {
  setInterval(async () => {
    try {
      const events = await kv.zpopmin("system:events:queue", 1);
      if (!events |

| events.length === 0) return;

      const eventStr = Array.isArray(events)? events : events;
      const event = JSON.parse(eventStr);
      let webhook = process.env.DISCORD_WEBHOOK_MARKET_RADAR;
      let title = "";
      
      if (event.type === "EMERGENCY_KILL") {
          webhook = process.env.DISCORD_WEBHOOK_HIGH_ALERT;
          title = `🚨 KILL SWITCH: ${event.data.reason}`;
      } else if (event.type === "TRADE_OPENED") {
          webhook = process.env.DISCORD_WEBHOOK_TRADE_OPENED;
          title = `🚀 ${event.data.system.toUpperCase()} ${event.data.side} OPENED: ${event.symbol}`;
      } else if (event.type === "TRADE_CLOSED") {
          webhook = process.env.DISCORD_WEBHOOK_TRADE_CLOSED;
          title = `✅ TRADE CLOSED: ${event.symbol} (${event.data.reason})`;
      } else if (event.type === "STAGE_UPGRADE") {
          title = `🟡 STAGE UPGRADE: ${event.symbol} -> ${event.data.stage}`;
      }

      if (title) await sendDiscord(webhook, title, JSON.stringify(event.data));
    } catch (err) {
      console.error("Discord Router Error:", err);
    }
  }, 1500); // Max 1 event per 1.5s is extreem safe voor Discord rate limits
}

// Start queue automatisch bij inladen op de VPS
startDiscordQueueProcessor();
