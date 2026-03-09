import { kv } from "@vercel/kv";

const NS = "cc:moon";
const KEY_LIST = `${NS}:signal:list`;

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function ensureAbsoluteUrl(base, path) {
  if (!base) throw new Error("Base URL is empty");

  let baseStr = String(base).trim();
  if (!baseStr.startsWith("http://") && !baseStr.startsWith("https://")) {
    baseStr = `https://${baseStr}`;
  }

  if (baseStr.endsWith("/")) baseStr = baseStr.slice(0, -1);

  const full = `${baseStr}${path}`;
  try {
    new URL(full);
    return full;
  } catch {
    throw new Error(`Invalid URL constructed: ${full}`);
  }
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
  const id = `${NS}:signal:${Date.now()}:${String(payload.symbol || "").toUpperCase()}:${Math.random()
    .toString(36)
    .substring(2, 8)}`;

  const row = {
    signal_id: id,
    timestamp: Date.now(),
    ...payload,
  };

  await kv.set(id, row);

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

export async function runMoonAll({ base, token, fetchFn, sleepMs = 1500, maxMs = 25000 }) {
  const START = Date.now();

  function ensureTime() {
    if (Date.now() - START > maxMs) {
      throw new Error("run-all exceeded safe time budget");
    }
  }

  const t = Date.now();

  const scanBullUrl = ensureAbsoluteUrl(
    base,
    `/api/moon/scan?mode=bull&token=${encodeURIComponent(token)}&_t=${t}`
  );
  const scanBearUrl = ensureAbsoluteUrl(
    base,
    `/api/moon/scan?mode=bear&token=${encodeURIComponent(token)}&_t=${t}`
  );

  const scanBullRes = await fetchFn(scanBullUrl);
  const scanBullText = await scanBullRes.text();
  ensureTime();

  await sleep(sleepMs);

  const scanBearRes = await fetchFn(scanBearUrl);
  const scanBearText = await scanBearRes.text();
  ensureTime();

  return {
    ok: true,
    scope: "bull+bear",
    steps: {
      scanBull: {
        ok: scanBullRes.ok,
        status: scanBullRes.status,
        preview: scanBullText.slice(0, 300),
      },
      scanBear: {
        ok: scanBearRes.ok,
        status: scanBearRes.status,
        preview: scanBearText.slice(0, 300),
      },
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}