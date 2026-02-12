import { getOutput } from "../lib/funnel.js";

export default async function handler(req, res) {
  const side = (req.query?.side || "bull").toString().toLowerCase();
  if (!["bull","bear"].includes(side)) {
    return res.status(400).json({ ok:false, error:"side must be bull or bear" });
  }
  try {
    const out = await getOutput(side);
    res.status(200).json({ ok:true, out });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
}
