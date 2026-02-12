const { runScanBoth } = require("./_lib/scan");

module.exports = async (req, res) => {
  try {
    const out = await runScanBoth();
    res.status(200).json({ ok: true, ts: Date.now(), message: "Cron scan done", sides: ["bull","bear"] });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
