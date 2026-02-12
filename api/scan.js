import { getMarkets } from "../lib/coingecko.js";
import { runFunnel, tryLock, unlock } from "../lib/funnel.js";

export default async function handler(req, res) {
  const side = (req.query?.side || "bull").toString().toLowerCase();
  if (!["bull","bear"].includes(side)) {
    return res.status(400).json({ ok:false, error:"side must be bull or bear" });
  }

  const locked = await tryLock(side);
  if (!locked) {
    return res.status(200).json({ ok:true, message:"scan running", side });
  }

  try {
    const coins = await getMarkets({ perPage: 250, page: 1 });
    const out = await runFunnel(side, coins);
    return res.status(200).json({ ok:true, out });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e.message });
  } finally {
    await unlock(side);
  }
}
