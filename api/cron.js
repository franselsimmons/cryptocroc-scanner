import scan from "./scan.js";
import { json } from "./_core.js";

export default async function handler(req){
  try{
    // Optional: als je later een secret wil:
    // const auth = req.headers.get("authorization") || "";
    // if(process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) return json({ok:false,error:"unauthorized"},401);

    // Run bull + bear scans back-to-back
    // We call the scan handler by faking req.url
    const base = new URL(req.url);
    const bullUrl = new URL(base.toString()); bullUrl.searchParams.set("side","bull");
    const bearUrl = new URL(base.toString()); bearUrl.searchParams.set("side","bear");

    const bullRes = await scan(new Request(bullUrl.toString(), { method:"GET" }));
    const bearRes = await scan(new Request(bearUrl.toString(), { method:"GET" }));

    const b1 = await bullRes.json();
    const b2 = await bearRes.json();

    return json({ ok:true, bull:b1.ok, bear:b2.ok, ts: Date.now() });
  }catch(e){
    return json({ ok:false, error: e.message || String(e) }, 500);
  }
}
