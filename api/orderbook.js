import { kv } from "@vercel/kv";
import { fetchOrderbookBitget, zScoreFromHist, obStatusFromScore } from "./_core.js";

export const config = { runtime: "nodejs" };

export default async function handler(req, res){
  try{
    const side = (req.query.side || "bull").toLowerCase();
    const symbol = String(req.query.symbol || "").toUpperCase();
    if (!symbol) return res.status(400).json({ ok:false, error:"symbol ontbreekt" });

    const mem = await kv.get(`mem:${side}:${symbol}`);
    if (!mem) return res.status(200).json({ ok:true, note:"Geen memory voor deze coin (nog niet gezien).", raw:{} });

    const symbolUSDT = `${symbol}USDT`;
    const ob = await fetchOrderbookBitget(symbolUSDT);

    const obScore = Number(ob.obScore.toFixed(4));
    const z = Number(zScoreFromHist(mem.obHist || [], obScore).toFixed(3));
    const spreadPct = ob.spreadPct == null ? null : Number(ob.spreadPct.toFixed(4));
    const obStatus = obStatusFromScore(side, obScore, spreadPct);

    res.status(200).json({
      ok:true,
      stage: mem.stage,
      timingScore: null,
      obScore,
      zScore: z,
      spreadPct,
      obStatus,
      note: "Orderbook live via Bitget.",
      raw: ob.raw
    });

  } catch(e){
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
}
