// api/reset.js
import { kv } from "@vercel/kv";
import { requireSecret, getMode, RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj, null, 2));
}

async function del(key) {
  try {
    await kv.del(key);
    return { key, ok: true };
  } catch (e) {
    return { key, ok: false, error: String(e?.message || e) };
  }
}

async function deleteByPrefix(prefix) {
  const deleted = [];
  let cursor = 0;

  do {
    const [nextCursor, keys] = await kv.scan(cursor, {
      match: `${prefix}*`,
      count: 100,
    });

    cursor = Number(nextCursor);

    for (const k of keys) {
      deleted.push(await del(k));
    }

  } while (cursor !== 0);

  return deleted;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req);           // bull / bear
    const hard = String(req.query?.hard || "0") === "1";
    const ultra = String(req.query?.ultra || "0") === "1";

    const out = [];

    // ======================================================
    // 1️⃣ MAIN FUNNEL RESET
    // ======================================================

    out.push(await del(`latest:${mode}`));
    out.push(await del(`state:${mode}`));

    // eventuele oude keys
    out.push(await del(`trades:main`));
    out.push(await del(`events:main`));

    // ======================================================
    // 2️⃣ HARD RESET (OB MAP)
    // ======================================================

    if (hard || ultra) {
      out.push(await del(`ob:map:${mode}`));
      out.push(await del(`ob:mapts:${mode}`));
    }

    // ======================================================
    // 3️⃣ ULTRA RESET (ALLE OB DATA + DISCORD CACHE)
    // ======================================================

    let ultraDeleted = [];
    if (ultra) {
      ultraDeleted = [
        ...(await deleteByPrefix(`ob:samples:${mode}:`)),
        ...(await deleteByPrefix(`ob:result:${mode}:`)),
        ...(await deleteByPrefix(`discord:last:main:${mode}:`)),
      ];
    }

    return json(res, 200, {
      ok: true,
      mode,
      hard,
      ultra,
      mainDeleted: out,
      ultraDeleted,
      note: ultra
        ? "ULTRA RESET: alles gewist incl OB samples + discord cache."
        : hard
        ? "HARD RESET: main + ob map gewist."
        : "MAIN RESET: alleen tabellen + state gewist.",
    });

  } catch (e) {
    return json(res, 500, {
      ok: false,
      error: String(e?.message || e),
    });
  }
}