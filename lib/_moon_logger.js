// /lib/_moon_logger.js
import { kv } from "@vercel/kv";

const NS = "cc:moon";
const KEY_LIST = `${NS}:signal:list`; // index (rolling)

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export function computeInstability({
  direction,
  volumeRoc5m,
  obSlope,
  obStability,
  depthBidUsd,
  depthAskUsd,
}) {
  const vol = Math.max(0, n(volumeRoc5m, 0));
  const slope = Math.abs(n(obSlope, 0));
  const stab = n(obStability, 0);

  const depthOpp = direction === "bull" ? n(depthAskUsd, 0) : n(depthBidUsd, 0);
  if (!(depthOpp > 0)) return 0;

  return (vol * slope) / (depthOpp * (stab + 0.01));
}

export async function logMoonSignal(payload) {
  const id = `${NS}:signal:${Date.now()}:${String(payload.symbol || "").toUpperCase()}:${Math.random().toString(36).substring(2, 8)}`;

  const row = {
    signal_id: id,
    timestamp: Date.now(),
    ...payload,
  };

  await kv.set(id, row);

  // ✅ rolling index (max 500)
  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(KEY_LIST, id);
    await kv.ltrim(KEY_LIST, 0, 499);
  }

  return id;
}

export async function logMoonOutcome(signalId, outcome) {
  const key = `${NS}:outcome:${String(signalId || "").split(":signal:").pop() || Date.now()}`;
  await kv.set(key, { ...outcome, timestamp: Date.now(), signal_id: signalId });
}