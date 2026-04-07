import { kv } from "@vercel/kv";

const EVENT_KEY_PREFIX = "analytics:events:";

function eventKey(name) {
  return `${EVENT_KEY_PREFIX}${name}`;
}

export async function pushEvent(name, payload) {
  try {
    const key = eventKey(name);
    const list = await kv.lpush(key, JSON.stringify({ ts: Date.now(), ...payload }));
    await kv.ltrim(key, 0, 9999);
    return list;
  } catch (e) {
    console.error("pushEvent error:", e);
    return null;
  }
}

export async function readEvents(name, limit = 1000) {
  try {
    const key = eventKey(name);
    const items = await kv.lrange(key, 0, limit - 1);
    return items.map((x) => {
      try {
        return typeof x === "string" ? JSON.parse(x) : x;
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch (e) {
    console.error("readEvents error:", e);
    return [];
  }
}

// ========== NIEUWE FUNCTIES ==========
export function inferSystemFromTradeId(id) {
  const v = String(id || "").toLowerCase();
  if (v.startsWith("moon_")) return "moon";
  if (v.startsWith("main_")) return "main";
  return "unknown";
}

export async function readTradeEventBook(limit = 5000) {
  const opened = await readEvents("trade_opened", limit);
  const closed = await readEvents("trade_closed", limit);
  return { opened, closed };
}

export async function readManyEvents(names = [], limit = 2000) {
  const out = {};
  for (const name of names) {
    out[name] = await readEvents(name, limit);
  }
  return out;
}