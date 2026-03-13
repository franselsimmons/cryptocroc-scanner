// lib/_analytics.js
import { kv } from "@vercel/kv";

const KEEP = 5000;
const EVENTS_KEY = (funnel) => `cc:events:${funnel}:list`;
const DEDUPE_TTL_SEC = 60 * 60 * 6; // 6 uur

// ======================================================
// Hulpfunctie voor UID
// ======================================================
export function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

// ======================================================
// Deduplicatie key
// ======================================================
function dedupeKey(funnel, item) {
  const f = String(funnel || "").toLowerCase();
  const symbol = String(item?.symbol || "?").toUpperCase();

  // Speciale gevallen voor trade_opened en trade_closed: gebruik event ID om meerdere trades voor zelfde symbool toe te staan
  if (f === "trade_opened") {
    return `cc:dedupe:${f}:${symbol}:${String(item?.id || "")}`;
  }

  if (f === "trade_closed") {
    return `cc:dedupe:${f}:${symbol}:${String(item?.id || "")}:${String(item?.reason || "")}`;
  }

  if (f === "scan_transition") {
    const from = String(item?.from || "").toUpperCase();
    const to = String(item?.to || "").toUpperCase();
    const reason = String(item?.reason || "").slice(0, 120);
    return `cc:dedupe:${f}:${symbol}:${from}->${to}:${reason}`;
  }

  if (f.startsWith("scan_")) {
    const stage = String(item?.stage || "").toUpperCase();
    const prevStage = String(item?.prevStage || "").toUpperCase();
    const reason = String(item?.reason || "").slice(0, 120);
    return `cc:dedupe:${f}:${symbol}:${prevStage}->${stage}:${reason}`;
  }

  // Voor alle overige events (bv. hold updates) gebruiken we alleen symbool + reden (indien aanwezig)
  const exitReason = String(item?.exitReason || item?.reason || "").slice(0, 120);
  return `cc:dedupe:${f}:${symbol}:${exitReason}`;
}

// ======================================================
// Push event
// Slaat alleen analytics/logging op in KV.
// GEEN directe Discord posting meer.
// ======================================================
export async function pushEvent(funnel, eventData) {
  const dedupe = dedupeKey(funnel, eventData);

  try {
    const ok = await kv.set(dedupe, "1", { nx: true, ex: DEDUPE_TTL_SEC });
    if (!ok) return null;
  } catch {}

  const key = EVENTS_KEY(funnel);

  const event = {
    id: uid("evt"),
    ts: Date.now(),
    ...eventData,
  };

  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(event));
    await kv.ltrim(key, 0, KEEP - 1);
  } else {
    const prev = (await kv.get(key)) || [];
    const arr = Array.isArray(prev) ? prev : [];
    arr.unshift(event);
    await kv.set(key, arr.slice(0, KEEP));
  }

  return event.id;
}

// ======================================================
// Read events
// ======================================================
export async function readEvents(funnel, limit = 2000) {
  const key = EVENTS_KEY(funnel);

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

  const data = await kv.get(key);
  return Array.isArray(data) ? data.slice(0, limit) : [];
}