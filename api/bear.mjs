import { getScanCached } from "./_runner.mjs";

export default async function handler(req, res) {
  try {
    const data = await getScanCached();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(data.bear);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
}
