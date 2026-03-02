// EOF: /api/reset.js
import { kv } from "@vercel/kv";
import { requireSecret, RUNTIME_CONFIG } from "../lib/_runtime.js";

export const config = RUNTIME_CONFIG;

function json(res, code, obj) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(obj, null, 2));
}

function getParams(req) {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const modeRaw = String(u.searchParams.get("mode") || "bull").toLowerCase();
  const mode = modeRaw === "bear" ? "bear" : "bull";
  const hard = u.searchParams.get("hard") === "1";
  const ultra = u.searchParams.get("ultra") === "1";
  return { mode, hard, ultra };
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
  // als scan niet bestaat: niet crashen
  if (typeof kv.scan !== "function") {
    deleted.push({ key: `${prefix}*`, ok: false, error: "kv.scan not available" });
    return deleted;
  }

  let cursor = 0;
  do {
    const res = await kv.scan(cursor, { match: `${prefix}*`, count: 500 });
    const nextCursor = Array.isArray(res) ? res[0] : 0;
    const keys = Array.isArray(res) ? res[1] : [];

    cursor = Number(nextCursor || 0);

    for (const k of keys) deleted.push(await del(k));
  } while (cursor !== 0);

  return deleted;
}

export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const { mode, hard, ultra } = getParams(req);

    const mainDeleted = [];
    const extraDeleted = [];

    // 1) MAIN: funnel + state
    mainDeleted.push(await del(`latest:${mode}`));
    mainDeleted.push(await del(`state:${mode}`));
    mainDeleted.push(await del(`reset:${mode}`));

    // analyzer/diag (als je ze gebruikt)
    mainDeleted.push(await del(`diag:list:${mode}`));
    mainDeleted.push(await del(`diag:snap:${mode}`));

    // 2) TRADES: open trades + cooldown + sells log
    // (dit is wat je “alles 0” maakt)
    mainDeleted.push(await del(`trade:sells:${mode}`));
    extraDeleted.push(...(await deleteByPrefix(`trade:${mode}:`)));
    extraDeleted.push(...(await deleteByPrefix(`trade:cooldown:${mode}:`)));

    // 3) HARD: OB map
    if (hard || ultra) {
      mainDeleted.push(await del(`ob:map:${mode}`));
      mainDeleted.push(await del(`ob:mapts:${mode}`));
    }

    // 4) ULTRA: alle OB samples/result + discord throttle keys (als je die gebruikt)
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
      mainDeleted,
      extraDeleted,
      ultraDeleted,
      note: ultra
        ? "ULTRA RESET: alles 0 incl trades + cooldown + sells + OB samples/result."
        : hard
        ? "HARD RESET: alles 0 incl trades + cooldown + sells + OB map."
        : "MAIN RESET: alles 0 incl trades + cooldown + sells (zonder OB samples/result).",
    });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e?.message || e) });
  }
}