import { kv } from "@vercel/kv";
import WebSocket from "ws";
import {
  resolveFunnelConflicts,
  computeFunnelGate,
  entryTriggerOk,
  hardBreakDetected
} from "./_trade_engine_core.js";
import { queueDiscordEvent, startDiscordQueueProcessor } from "./discordRouter.js";

let positions = { open: [], closed: [] };
let market = {};

async function execute(action, symbol, size, side) {
  return { success: true, price: market[symbol]?.price || 0 };
}

function initWS() {
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");

  ws.on("open", () => {
    ws.send(JSON.stringify({
      op: "subscribe",
      args: [{ instType: "mc", channel: "ticker", instId: "BTCUSDT" }]
    }));
  });

  ws.on("message", (data) => {
    const j = JSON.parse(data);
    if (!j.data) return;

    const arr = Array.isArray(j.data) ? j.data : [j.data];

    for (const p of arr) {
      const sym = (j.arg?.instId || "").replace("USDT", "");
      if (!market[sym]) market[sym] = {};

      if (p.lastPr) market[sym].price = parseFloat(p.lastPr);
    }
  });
}

async function funnelLoop(mode) {
  const key = `trade_funnel:raw_queue:${mode}`;
  const raw = await kv.lrange(key, 0, -1);
  if (!raw.length) return;

  await kv.del(key);

  const resolved = resolveFunnelConflicts(raw, Date.now());

  const enriched = resolved.map(i => {
    i.engineGate = computeFunnelGate(i);
    return i;
  });

  const valid = enriched.filter(x => x.engineGate !== "IGNORE");

  await kv.set(`engine:candidates:${mode}`, valid);
}

async function engineLoop(mode) {
  let cands = await kv.get(`engine:candidates:${mode}`) || [];

  for (const c of cands) {
    const live = market[c.symbol];
    if (!live) continue;

    if (entryTriggerOk({
      price: live.price,
      entry: c.tradePlan.entry,
      spreadPct: live.spreadPct || 0
    })) {
      const fill = await execute("OPEN", c.symbol, c.tradePlan.size, c.side);

      if (fill.success) {
        positions.open.push({
          symbol: c.symbol,
          entryPrice: fill.price,
          side: c.side
        });

        queueDiscordEvent(2, "TRADE_OPENED", c.symbol, {});
      }
    }
  }
}

export async function init() {
  initWS();
  startDiscordQueueProcessor();

  setInterval(() => funnelLoop("bull"), 3000);
  setInterval(() => engineLoop("bull"), 1000);
}

init();