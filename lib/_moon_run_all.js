import { kv } from "@vercel/kv";

const NS = "cc:moon";
const KEY_LIST = `${NS}:signal:list`; // index (rolling)

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

// FIX: Helper om een absolute URL te maken
function ensureAbsoluteUrl(base, path) {
  if (!base) throw new Error("Base URL is empty");
  let baseStr = String(base).trim();
  if (!baseStr.startsWith("http://") && !baseStr.startsWith("https://")) {
    baseStr = "https://" + baseStr;
  }
  // verwijder trailing slash
  if (baseStr.endsWith("/")) baseStr = baseStr.slice(0, -1);
  const full = baseStr + path;
  try {
    new URL(full); // validate
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

export async function runMoonAll({ base, token, fetchFn, sleepMs = 2000, maxMs = 25_000 }) {
  const START = Date.now();

  function ensureTime() {
    if (Date.now() - START > maxMs) {
      throw new Error("run-all exceeded safe time budget");
    }
  }

  const t = Date.now();

  // FIX: Gebruik ensureAbsoluteUrl voor elke URL
  const scanBull1Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bull&token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBear1Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bear&token=${encodeURIComponent(token)}&_t=${t}`);
  const obUrl = ensureAbsoluteUrl(base, `/api/moon/ob-sampler?token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBull2Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bull&token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBear2Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bear&token=${encodeURIComponent(token)}&_t=${t}`);

  console.log("[MOON run-all] scanBull1Url=", scanBull1Url); // FIX: debug

  const scanBull1Res = await fetchFn(scanBull1Url);
  const scanBull1Text = await scanBull1Res.text();

  const scanBear1Res = await fetchFn(scanBear1Url);
  const scanBear1Text = await scanBear1Res.text();

  await sleep(sleepMs);
  ensureTime();

  // Warmup OB
  const obRes = await fetchFn(obUrl);
  const obText = await obRes.text();
  const obData = safeJson(obText);

  await sleep(sleepMs);
  ensureTime();

  // Tweede scan met verse OB data
  const scanBull2Res = await fetchFn(scanBull2Url);
  const scanBull2Text = await scanBull2Res.text();

  const scanBear2Res = await fetchFn(scanBear2Url);
  const scanBear2Text = await scanBear2Res.text();

  return {
    ok: true,
    scope: "bull+bear",
    steps: {
      scanBull1: { ok: scanBull1Res.ok, status: scanBull1Res.status, preview: scanBull1Text.slice(0, 200) },
      scanBear1: { ok: scanBear1Res.ok, status: scanBear1Res.status, preview: scanBear1Text.slice(0, 200) },
      obSampler: { ok: obRes.ok, status: obRes.status, data: obData },
      scanBull2: { ok: scanBull2Res.ok, status: scanBull2Res.status, preview: scanBull2Text.slice(0, 200) },
      scanBear2: { ok: scanBear2Res.ok, status: scanBear2Res.status, preview: scanBear2Text.slice(0, 200) },
    },
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 400) };
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}