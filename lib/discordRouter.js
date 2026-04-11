import { kv } from "@vercel/kv";

export async function sendDiscord(webhookUrl, title, message) {
  if (!webhookUrl) return;
  try {
      await fetch(webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: `**${title}**\n${message}` }) });
  } catch(e) { }
}

let nonceCounter = 0;
export async function queueDiscordEvent(priority, type, symbol, data) {
  const score = (priority * 1e13) + (Date.now() * 1000) + (nonceCounter++ % 1000);
  await kv.zadd("system:events:queue", { score, member: JSON.stringify({ type, symbol, data }) });
}

export async function startDiscordQueueProcessor() {
  setInterval(async () => {
    try {
      const events = await kv.zpopmin("system:events:queue", 1);
      if (!events |

| events.length === 0) return;

      const event = JSON.parse(Array.isArray(events)? events : events);
      let webhook = process.env.DISCORD_WEBHOOK_MARKET_RADAR;
      let title = "";
      
      if (event.type === "EMERGENCY_KILL") { webhook = process.env.DISCORD_WEBHOOK_HIGH_ALERT; title = `🚨 KILL SWITCH: ${event.data.reason}`; } 
      else if (event.type === "TRADE_OPENED") { webhook = process.env.DISCORD_WEBHOOK_TRADE_OPENED; title = `🚀 ${event.data.system.toUpperCase()} ${event.data.side} OPENED: ${event.symbol}`; } 
      else if (event.type === "TRADE_CLOSED") { webhook = process.env.DISCORD_WEBHOOK_TRADE_CLOSED; title = `✅ TRADE CLOSED: ${event.symbol} (${event.data.reason})`; } 
      else if (event.type === "STAGE_UPGRADE") { title = `🟡 STAGE UPGRADE: ${event.symbol} -> ${event.data.stage}`; }

      if (title) await sendDiscord(webhook, title, JSON.stringify(event.data));
    } catch (err) {}
  }, 1500); 
}
