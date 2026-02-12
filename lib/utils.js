export const now = () => Date.now();

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

export function safeNum(x, def = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : def;
}

export function pct(a, b) {
  if (!b) return 0;
  return (a / b) * 100;
}

export function idToSymbolGuess(sym) {
  // simpele USDT pair guess
  // (werkt voor veel grote coins; bij meme/smallcaps kan exchange mapping missen → dan OB = null)
  return String(sym || "").toUpperCase().replace(/[^A-Z0-9]/g, "") + "USDT";
}

export async function fetchJson(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { "accept": "application/json", ...(opts.headers||{}) } });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  } finally {
    clearTimeout(t);
  }
}
