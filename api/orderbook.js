const { kv } = require("@vercel/kv");

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("id");
    const side = url.searchParams.get("side") || "bull";

    if (!id) return res.status(200).json({ ok: false, error: "missing id" });

    // Pak mem en ob history (zodat UI 'strak' blijft)
    const mem = await kv.get(`mem:${side}:${id}`);
    const obHist = await kv.get(`ob:${id}`);

    res.status(200).json({ ok: true, side, id, mem: mem || null, obHist: obHist || [] });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
