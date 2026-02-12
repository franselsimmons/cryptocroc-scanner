import { kv } from "@vercel/kv";
import { json } from "./_core.js";

export default async function handler(req){
  try{
    const url = new URL(req.url);
    const side = (url.searchParams.get("side") || "bull").toLowerCase();
    if(side!=="bull" && side!=="bear") return json({ ok:false, error:"side must be bull|bear" }, 400);

    const data = await kv.get(`latest:${side}`);
    if(!data) return json({ ok:true, data: null });

    return json({ ok:true, data });
  }catch(e){
    return json({ ok:false, error: e.message || String(e) }, 500);
  }
}
