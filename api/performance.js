import { getPerformance } from "../lib/performance.js";

const SYSTEM_PROFILE = "RUNNER";

export default function handler(req, res) {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const perf = getPerformance();

    return res.status(200).json({
      ok: true,
      profile: SYSTEM_PROFILE,
      performance: perf,
      servedAt: Date.now()
    });
  } catch (err) {
    console.error("RUNNER PERFORMANCE ERROR:", err);

    return res.status(500).json({
      ok: false,
      profile: SYSTEM_PROFILE,
      error: err?.message || "performance_failed",
      servedAt: Date.now()
    });
  }
}