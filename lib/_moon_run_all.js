export async function runMoonAll({ base, token, fetchFn, sleepMs = 2000, maxMs = 25_000 }) {
  const START = Date.now();

  function ensureTime() {
    if (Date.now() - START > maxMs) {
      throw new Error("run-all exceeded safe time budget");
    }
  }

  const t = Date.now();

  // Eerste scan om funnel te vullen
  const scanBull1Res = await fetchFn(`${base}/api/moon/scan?mode=bull&token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBull1Text = await scanBull1Res.text();

  const scanBear1Res = await fetchFn(`${base}/api/moon/scan?mode=bear&token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBear1Text = await scanBear1Res.text();

  await sleep(sleepMs);
  ensureTime();

  // Warmup OB
  const obRes = await fetchFn(`${base}/api/moon/ob-sampler?token=${encodeURIComponent(token)}&_t=${t}`);
  const obText = await obRes.text();
  const obData = safeJson(obText);

  await sleep(sleepMs);
  ensureTime();

  // Tweede scan met verse OB data
  const scanBull2Res = await fetchFn(`${base}/api/moon/scan?mode=bull&token=${encodeURIComponent(token)}&_t=${t}`);
  const scanBull2Text = await scanBull2Res.text();

  const scanBear2Res = await fetchFn(`${base}/api/moon/scan?mode=bear&token=${encodeURIComponent(token)}&_t=${t}`);
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