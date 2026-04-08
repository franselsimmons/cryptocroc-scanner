import { kv } from "@vercel/kv";

const EVENT_KEY_PREFIX = "analytics:events:";
const DEFAULT_EVENT_LIMIT = 1000;
const MAX_EVENT_LIMIT = 10000;
const EVENT_BOOK_TRIM = 9999;

function eventKey(name) {
  return `${EVENT_KEY_PREFIX}${String(name || "").trim()}`;
}

function safeLimit(limit, fallback = DEFAULT_EVENT_LIMIT) {
  const v = Number(limit);
  if (!Number.isFinite(v) || v <= 0) return fallback;
  return Math.min(Math.floor(v), MAX_EVENT_LIMIT);
}

function safeParseEvent(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
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
    const eventName = String(name || "").trim();
    if (!eventName) {
      throw new Error("pushEvent requires a non-empty event name");
    }

    const key = eventKey(eventName);
    const item = {
      ts: Date.now(),
      ...(payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : { value: payload }),
    };

    await kv.lpush(key, JSON.stringify(item));
    await kv.ltrim(key, 0, EVENT_BOOK_TRIM);

    return item;
  } catch (error) {
    console.error(`pushEvent error (${name}):`, error);
    return null;
  }
}

export async function readEvents(name, limit = DEFAULT_EVENT_LIMIT) {
  try {
    const eventName = String(name || "").trim();
    if (!eventName) return [];

    const key = eventKey(eventName);
    const safe = safeLimit(limit);
    const items = await kv.lrange(key, 0, safe - 1);

    return (items || []).map(safeParseEvent).filter(Boolean);
  } catch (error) {
    console.error(`readEvents error (${name}):`, error);
    return [];
  }
}

export function inferSystemFromTradeId(id) {
  const value = String(id || "").toLowerCase();

  if (value.startsWith("moon_")) return "moon";
  if (value.startsWith("main_")) return "main";

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
  const output = {};

  for (const rawName of Array.isArray(names) ? names : []) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    output[name] = await readEvents(name, safe);
  }

  return output;
}