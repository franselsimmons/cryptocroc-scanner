import { kv } from "@vercel/kv";

export function obMapKey(mode) {
  return `ob:map:${String(mode).toLowerCase()}`;
}

export function obKey(mode, symbol) {
  return `ob:snap:${String(mode).toLowerCase()}:${String(symbol).toUpperCase()}`;
}

// Backwards compat alias (jij gebruikte soms obKey())
export const obKeyCompat = obKey;

function safeObj(x) {
  return x && typeof x === "object" ? x : null;
}

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

export async function putObSnapshot(mode, symbol, snap, ttlSec = 60 * 60) {
  try {
    const m = String(mode).toLowerCase();
    const sym = String(symbol).toUpperCase();

    if (m !== "bull" && m !== "bear") return { ok: false, why: "invalid_mode" };
    if (!sym) return { ok: false, why: "missing_symbol" };

    const s = safeObj(snap);
    if (!s) return { ok: false, why: "invalid_snap" };

    const payload = {
      ts: Date.now(),
      symbol: sym,
      snap: {
        ts: n(s.ts, Date.now()),
        mid: Number.isFinite(Number(s.mid)) ? Number(s.mid) : null,
        spreadPct: Number.isFinite(Number(s.spreadPct)) ? Number(s.spreadPct) : null,
        bidUsd1p: Number.isFinite(Number(s.bidUsd1p)) ? Number(s.bidUsd1p) : null,
        askUsd1p: Number.isFinite(Number(s.askUsd1p)) ? Number(s.askUsd1p) : null,
        depthMinUsd1p: Number.isFinite(Number(s.depthMinUsd1p)) ? Number(s.depthMinUsd1p) : null,
        pressureDeltaUsd: Number.isFinite(Number(s.pressureDeltaUsd)) ? Number(s.pressureDeltaUsd) : 0,
        score: Number.isFinite(Number(s.score)) ? Number(s.score) : null,
        lor: Number.isFinite(Number(s.lor)) ? Number(s.lor) : null,
        levels: safeObj(s.levels) || null,
      },
    };

    const key = obKey(m, sym);
    await kv.set(key, payload, { ex: Math.max(60, n(ttlSec, 3600)) });

    // handige debug keys (zodat je NOOIT meer hoeft te gokken)
    await kv.set(
      `ob:last:${m}:${sym}`,
      { ts: payload.ts, key, snapTs: payload.snap.ts },
      { ex: Math.max(300, n(ttlSec, 3600)) }
    );

    return { ok: true, key, ts: payload.ts };
  } catch (e) {
    return { ok: false, why: String(e?.message || e) };
  }
}

export async function getObSnapshot(mode, symbol, maxAgeSec = 60 * 60) {
  const m = String(mode).toLowerCase();
  const sym = String(symbol).toUpperCase();

  const key = obKey(m, sym);

  // 👇 NIEUW: guard tegen ongeldige mode (voorkomt key-vervuiling)
  if (m !== "bull" && m !== "bear") {
    return {
      ok: false,
      valid: false,
      fresh: false,
      stale: true,
      reason: "invalid_mode",
      key,
      symbol: sym,
      mode: m,
      ageSec: null,
      snap: null,
    };
  }

  let blob = null;
  try {
    blob = await kv.get(key);
  } catch (e) {
    return {
      ok: false,
      valid: false,
      fresh: false,
      stale: true,
      reason: "kv_get_failed",
      error: String(e?.message || e),
      key,
      symbol: sym,
      mode: m,
      ageSec: null,
      snap: null,
    };
  }

  const obj = safeObj(blob);
  const snap = safeObj(obj?.snap);

  if (!obj || !snap) {
    return {
      ok: true,
      valid: false,
      fresh: false,
      stale: true,
      reason: "missing_snapshot",
      key,
      symbol: sym,
      mode: m,
      ageSec: null,
      snap: null,
    };
  }

  const now = Date.now();
  const snapTs = n(snap.ts, 0);
  const ageSec = snapTs > 0 ? Math.floor((now - snapTs) / 1000) : null;

  const maxAge = Math.max(60, n(maxAgeSec, 3600));
  const fresh = ageSec != null ? ageSec <= maxAge : false;

  // valid = we hebben kernvelden
  const spreadOk = Number.isFinite(Number(snap.spreadPct));
  const depthOk = Number.isFinite(Number(snap.depthMinUsd1p));
  const scoreOk = Number.isFinite(Number(snap.score));

  const valid = !!(spreadOk && depthOk && scoreOk);

  return {
    ok: true,
    valid,
    fresh,
    stale: !fresh,
    reason: fresh ? (valid ? "ok" : "invalid_fields") : "stale",
    key,
    symbol: sym,
    mode: m,
    ageSec,
    snap,
  };
}