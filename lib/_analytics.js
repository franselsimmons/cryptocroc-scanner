// /lib/_analytics.js
import { kv } from "@vercel/kv";

const EVENTS_KEY = (name) => `cc:events:${name}:list`;

export function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

async function lpushTrim(key, obj, keep = 5000) {
  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(obj));
    await kv.ltrim(key, 0, Math.max(0, keep - 1));
    return true;
  }
  // fallback: geen list support -> stop netjes
  return false;
}

export async function pushFunnelEvent(eventData, keep = 5000) {
  const key = EVENTS_KEY("funnel");
  const evt = { id: uid("evt"), ts: Date.now(), ...eventData };
  await lpushTrim(key, evt, keep);
  return evt.id;
}

export async function pushScanEvent(eventData, keep = 2000) {
  const key = EVENTS_KEY("scan");
  const evt = { id: uid("scan"), ts: Date.now(), ...eventData };
  await lpushTrim(key, evt, keep);
  return evt.id;
}

export async function readEvents(name, limit = 2000) {
  const key = EVENTS_KEY(name);
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
  return [];
}