import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

export default async function handler(req, res){
  try{
    // Vercel Cron roept dit endpoint aan. We triggeren beide kanten.
    const base = `https://${req.headers.host}`;

    // scan bull
    await fetch(`${base}/api/scan?side=bull`, { method: "GET" });
    // scan bear
    await fetch(`${base}/api/scan?side=bear`, { method: "GET" });

    res.status(200).json({ ok:true, ts: Date.now() });
  } catch(e){
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
}
