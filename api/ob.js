/* EOF: /api/ob.js */

import { kv } from "@vercel/kv";

function tryKeys(mode, pair) {
  const p = String(pair || "").toUpperCase();
  // probeer meerdere varianten, want jij hebt nu een mismatch ergens
  return [
    `ob:snap:${mode}:${p}`,
    `ob:snap:${mode}:${p.replace("-", "")}`,
    `ob:snap:${mode}:${p.replace("/", "")}`,
    `ob:snap:${mode}:${p.replace("-", "").replace("/", "")}`,
    `ob:snap:${p}`,                 // sommige setups gebruiken geen mode
    `ob:snap:${mode}:${p}:latest`,   // andere setups hebben :latest
  ];
}

export default async function handler(req, res) {
  try {
    const mode = String(req.query.mode || "bull").toLowerCase();
    const pair = String(req.query.key || req.query.pair || "").trim();

    if (!pair) {
      return res.status(400).json({ ok: false, error: "Provide ?key=PAIR (example: PEPEUSDT)" });
    }
    if (mode !== "bull" && mode !== "bear") {
      return res.status(400).json({ ok: false, error: "mode must be bull or bear" });
    }

    const candidates = tryKeys(mode, pair);

    let foundKey = null;
    let data = null;

    for (const k of candidates) {
      const v = await kv.get(k);
      if (v) {
        foundKey = k;
        data = v;
        break;
      }
    }

    return res.status(200).json({
      ok: true,
      mode,
      requested: pair,
      tried: candidates,
      foundKey,
      exists: !!data,
      data: data || null,
      ts: Date.now(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
}

/* EOF */