import { CFG, fetchBitgetOrderbook, calcObScore, zScoreFromHist, loadMem, saveMem } from "./_core.js";
export const config = { runtime: "nodejs" };

function json(res, code, obj){
  res.statusCode = code;
  res.setHeader("content-type","application/json; charset=utf-8");
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res){
  try{
    const u = new URL(req.url, "http://localhost");
    const symbol = u.searchParams.get("symbol");
    const mode = (u.searchParams.get("mode") || "bull").toLowerCase()==="bear" ? "bear":"bull";
    if(!symbol) return json(res, 400, { error:"missing symbol" });

    const ob = await fetchBitgetOrderbook(symbol, 50);
    const x = calcObScore(ob);
    if(!x) return json(res, 500, { error:"obScore failed" });

    // zscore history per "BitgetSymbol" in mem (we koppelen op symbol string)
    const mem = await loadMem(mode, symbol);
    mem.obHist = Array.isArray(mem.obHist) ? mem.obHist : [];
    mem.obHist.push(x.obScore);
    if(mem.obHist.length > CFG.orderbook.historyN) mem.obHist = mem.obHist.slice(-CFG.orderbook.historyN);
    const z = zScoreFromHist(mem.obHist, x.obScore);
    await saveMem(mode, symbol, mem);

    return json(res, 200, { ...x, zScore:z });
  }catch(e){
    return json(res, 500, { error:String(e?.message||e) });
  }
}
