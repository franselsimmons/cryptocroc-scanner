// /lib/_moon_run_all.js

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(s) {
  return String(s || "").replace(/\/+$/, "");
}

function joinUrl(base, path) {
  return `${trimSlash(base)}${path.startsWith("/") ? path : `/${path}`}`;
}

async function callJson(fetchFn, url, timeoutMs = 25_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const r = await fetchFn(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "cache-control": "no-store",
      },
      signal: ctrl.signal,
    });

    const text = await r.text().catch(() => "");
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { ok: false, error: text || `Invalid JSON from ${url}` };
    }

    return {
      ok: r.ok && !!json && json.ok !== false,
      status: r.status,
      url,
      json,
      raw: text,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      url,
      json: null,
      raw: "",
      error: String(e?.message || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

function stepResult(name, result) {
  return {
    step: name,
    ok: !!result?.ok,
    status: Number(result?.status || 0),
    url: result?.url || "",
    error:
      result?.error ||
      result?.json?.error ||
      result?.json?.message ||
      null,
    body: result?.json || null,
  };
}

export async function runMoonAll({
  base,
  token,
  fetchFn = globalThis.fetch,
  sleepMs = 1200,
  maxMs = 55_000,
}) {
  const startedAt = Date.now();
  const out = {
    ok: false,
    startedAt,
    finishedAt: null,
    tookMs: null,
    base: trimSlash(base),
    steps: [],
  };

  if (!base) {
    throw new Error("runMoonAll: missing base");
  }
  if (!token) {
    throw new Error("runMoonAll: missing token");
  }
  if (typeof fetchFn !== "function") {
    throw new Error("runMoonAll: invalid fetchFn");
  }

  const q = (path) => joinUrl(base, `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`);

  const remaining = () => maxMs - (Date.now() - startedAt);
  const guardTime = () => {
    if (remaining() <= 2500) {
      throw new Error("runMoonAll: time budget exceeded");
    }
  };

  // 1) Universe
  guardTime();
  const universe = await callJson(fetchFn, q("/api/moon/universe"), Math.min(remaining(), 25_000));
  out.steps.push(stepResult("universe", universe));
  if (!universe.ok) {
    out.finishedAt = Date.now();
    out.tookMs = out.finishedAt - startedAt;
    return out;
  }

  if (sleepMs > 0) await sleep(sleepMs);

  // 2) Map refresh bull
  guardTime();
  const mapBull = await callJson(fetchFn, q("/api/moon/map_refresh?mode=bull"), Math.min(remaining(), 20_000));
  out.steps.push(stepResult("map_refresh_bull", mapBull));

  if (sleepMs > 0) await sleep(sleepMs);

  // 3) Map refresh bear
  guardTime();
  const mapBear = await callJson(fetchFn, q("/api/moon/map_refresh?mode=bear"), Math.min(remaining(), 20_000));
  out.steps.push(stepResult("map_refresh_bear", mapBear));

  if (sleepMs > 0) await sleep(sleepMs);

  // 4) OB sampler bull
  guardTime();
  const obBull = await callJson(fetchFn, q("/api/moon/ob-sampler?mode=bull"), Math.min(remaining(), 25_000));
  out.steps.push(stepResult("ob_sampler_bull", obBull));

  if (sleepMs > 0) await sleep(sleepMs);

  // 5) OB sampler bear
  guardTime();
  const obBear = await callJson(fetchFn, q("/api/moon/ob-sampler?mode=bear"), Math.min(remaining(), 25_000));
  out.steps.push(stepResult("ob_sampler_bear", obBear));

  if (sleepMs > 0) await sleep(sleepMs);

  // 6) Scan bull
  guardTime();
  const scanBull = await callJson(fetchFn, q("/api/moon/scan?mode=bull"), Math.min(remaining(), 30_000));
  out.steps.push(stepResult("scan_bull", scanBull));

  if (sleepMs > 0) await sleep(sleepMs);

  // 7) Scan bear
  guardTime();
  const scanBear = await callJson(fetchFn, q("/api/moon/scan?mode=bear"), Math.min(remaining(), 30_000));
  out.steps.push(stepResult("scan_bear", scanBear));

  out.ok =
    universe.ok &&
    mapBull.ok &&
    mapBear.ok &&
    obBull.ok &&
    obBear.ok &&
    scanBull.ok &&
    scanBear.ok;

  out.latest = {
    bullTs: Number(scanBull?.json?.ts || 0) || null,
    bearTs: Number(scanBear?.json?.ts || 0) || null,
    bullCounts: scanBull?.json?.counts || null,
    bearCounts: scanBear?.json?.counts || null,
  };

  out.finishedAt = Date.now();
  out.tookMs = out.finishedAt - startedAt;

  return out;
}