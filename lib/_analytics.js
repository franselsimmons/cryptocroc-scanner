// /lib/_analytics.js
import { kv } from "@vercel/kv";

const EVENTS_KEY = (funnel) => `cc:events:${funnel}:list`;

export function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export async function pushEvent(funnel, eventData) {
  const key = EVENTS_KEY(funnel);
  const event = {
    id: uid("evt"),
    ts: Date.now(),
    ...eventData,
  };

  // ✅ bewaart meer (analyzer heeft iets nodig)
  const KEEP = 5000;

  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(event));
    await kv.ltrim(key, 0, KEEP - 1);
  } else {
    // fallback: set niet ideaal voor events, maar laat in ieder geval niet crashen
    await kv.set(key, [event]);
  }

  return event.id;
}

export async function readEvents(funnel, limit = 5000) {
  const key = EVENTS_KEY(funnel);
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(key, 0, Math.max(0, limit - 1));
      return (raw || [])
        .map((x) => { try { return typeof x === "string" ? JSON.parse(x) : x; } catch { return null; } })
        .filter(Boolean);
    }
  } catch {}
  return [];
}