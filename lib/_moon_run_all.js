function ensureAbsoluteUrl(base, path) {
  if (!base) throw new Error("Base URL is empty");

  let baseStr = String(base).trim();
  if (!baseStr.startsWith("http://") && !baseStr.startsWith("https://")) {
    baseStr = "https://" + baseStr;
  }
  if (baseStr.endsWith("/")) baseStr = baseStr.slice(0, -1);

  const full = baseStr + path;
  new URL(full);
  return full;
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

export async function runMoonAll({ base, token, fetchFn, sleepMs = 2000, maxMs = 25_000 }) {
  const START = Date.now();

  function ensureTime() {
    if (Date.now() - START > maxMs) {
      throw new Error("run-all exceeded safe time budget");
    }
  }

  const t = Date.now();

  const scanBull1Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bull&token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBear1Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bear&token=${encodeURIComponent(token)}&_t=${t}`);
  const obUrl = ensureAbsoluteUrl(base, `/api/moon/ob-sampler?token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBull2Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bull&token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBear2Url = ensureAbsoluteUrl(base, `/api/moon/scan?mode=bear&token=${encodeURIComponent(token)}&_t=${t}`);

  const scanBull1Res = await fetchFn(scanBull1Url);
  const scanBull1Text = await scanBull1Res.text();

  const scanBear1Res = await fetchFn(scanBear1Url);
  const scanBear1Text = await scanBear1Res.text();

  await sleep(sleepMs);
  ensureTime();

  const obRes = await fetchFn(obUrl);
  const obText = await obRes.text();
  const obData = safeJson(obText);

  await sleep(sleepMs);
  ensureTime();

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