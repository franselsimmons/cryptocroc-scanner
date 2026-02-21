// /api/_analytics.js
import { kv } from "@vercel/kv";

/**
 * Maak unieke ID voor trades/events
 */
export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * Lees trades uit KV
 * Wordt gebruikt door scan.js
 */
export async function readTrades(funnel = "main") {
  try {
    const data = await kv.get(`trades:${String(funnel)}`);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Schrijf trades naar KV
 */
export async function writeTrades(funnel = "main", trades = []) {
  try {
    const arr = Array.isArray(trades) ? trades : [];
    await kv.set(`trades:${String(funnel)}`, arr);
  } catch {
    // nooit crashen
  }
}

/**
 * Log event in KV
 * events worden opgeslagen als LIST
 */
export async function pushEvent(funnel = "main", event = {}) {
  try {
    const key = `events:${String(funnel)}`;

    if (typeof kv.lpush === "function") {
      await kv.lpush(key, JSON.stringify(event));

      if (typeof kv.ltrim === "function") {
        await kv.ltrim(key, 0, 500); // max 500 events bewaren
      }
    } else {
      // fallback als LIST niet beschikbaar is
      await kv.set(`${key}:${Date.now()}`, event, {
        ex: 60 * 60 * 24 * 30, // 30 dagen
      });
    }
  } catch {
    // nooit crashen
  }
}
