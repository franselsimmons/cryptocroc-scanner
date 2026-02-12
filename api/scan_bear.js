const { scanSide } = require("./_lib/scan");
const { kv } = require("@vercel/kv");

module.exports = async (req, res) => {
  try {
    const data = await scanSide("bear");
    await kv.set("latest:bear", data);
    res.status(200).json(data);
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
