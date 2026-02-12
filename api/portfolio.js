import { kv } from "@vercel/kv";
export const config = { runtime: "nodejs" };

const KEY = "portfolio:state";

function json(res, code, obj){
  res.setHeader("Content-Type","application/json");
  res.setHeader("Cache-Control","no-store");
  res.status(code).end(JSON.stringify(obj));
}

export default async function handler(req,res){
  try{
    const url = new URL(req.url, "http://localhost");
    const mode = url.searchParams.get("mode") || "get";

    if(mode === "get"){
      const state = (await kv.get(KEY)) || {
        equity: 1000,
        drawdownPct: 0,
        openPositions: []
      };
      return json(res, 200, { ok:true, state });
    }

    if(mode === "set"){
      // Stuur JSON body: { equity, drawdownPct, openPositions:[{symbol,side,riskPct,engine}] }
      let body = "";
      for await (const chunk of req) body += chunk;
      const incoming = JSON.parse(body || "{}");

      const state = {
        equity: Number(incoming.equity ?? 1000),
        drawdownPct: Number(incoming.drawdownPct ?? 0),
        openPositions: Array.isArray(incoming.openPositions) ? incoming.openPositions : []
      };

      await kv.set(KEY, state);
      return json(res, 200, { ok:true, saved:true, state });
    }

    return json(res, 400, { ok:false, error:"Invalid mode. Use ?mode=get or ?mode=set" });

  }catch(e){
    return json(res, 500, { ok:false, error:e.message });
  }
}
