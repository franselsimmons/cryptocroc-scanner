const { kv } = require("@vercel/kv");

module.exports = async (req, res) => {
  try {
    const data = await kv.get("latest:bull");
    if (!data) return res.status(200).json({ ok: true, side: "bull", empty: true, message: "Nog geen scan gedaan. Wacht op cron of klik Scan nu." });
    res.status(200).json(data);
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
