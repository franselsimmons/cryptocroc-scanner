import { kv } from "@vercel/kv";

const EVENT_KEY_PREFIX = "analytics:events:";
const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_BOOK = 10000;

function eventKey(name) {
  return `${EVENT_KEY_PREFIX}${String(name || "").trim()}`;
}

function safeLimit(limit, fallback = DEFAULT_EVENT_LIMIT) {
  const v = Number(limit);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), MAX_EVENT_BOOK);
}

function safeParseEvent(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : x;
  } catch {
    return null;
  }
}

export function uid(prefix = "id") {
  return `${String(prefix || "id")}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export async function pushEvent(name, payload = {}) {
  try {
    const key = eventKey(name);
    const item = {
      ts: Date.now(),
      ...(payload && typeof payload === "object" ? payload : { value: payload }),
    };

    await kv.lpush(key, JSON.stringify(item));
    await kv.ltrim(key, 0, 9999);

    return item;
  } catch (e) {
    console.error(`pushEvent error (${name}):`, e);
    return null;
  }
}

export async function readEvents(name, limit = DEFAULT_EVENT_LIMIT) {
  try {
    const key = eventKey(name);
    const safe = safeLimit(limit);
    const items = await kv.lrange(key, 0, safe - 1);

    return (items || []).map(safeParseEvent).filter(Boolean);
  } catch (e) {
    console.error(`readEvents error (${name}):`, e);
    return [];
  }
}

export function inferSystemFromTradeId(id) {
  const v = String(id || "").toLowerCase();

  if (v.startsWith("moon_")) return "moon";
  if (v.startsWith("main_")) return "main";

  return "unknown";
}

export async function readTradeEventBook(limit = 5000) {
  const safe = safeLimit(limit, 5000);

  const [opened, closed] = await Promise.all([
    readEvents("trade_opened", safe),
    readEvents("trade_closed", safe),
  ]);

  return { opened, closed };
}

export async function readManyEvents(names = [], limit = 2000) {
  const safe = safeLimit(limit, 2000);
  const out = {};

  for (const rawName of Array.isArray(names) ? names : []) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    out[name] = await readEvents(name, safe);
  }

  return out;
}