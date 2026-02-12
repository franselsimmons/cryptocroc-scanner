import { kv } from "@vercel/kv";
export const config = { runtime: "nodejs" };

export default async function handler(req, res){
  try{
    const side = (req.query.side || "bull").toLowerCase();
    const snap = await kv.get(`latest:${side}`);
    if (!snap){
      res.status(200).json({ ok:false, error:"Nog geen snapshot. Druk op Scan nu of wacht op cron." });
      return;
    }
    res.status(200).json({ ok:true, snapshot: snap });
  } catch(e){
    res.status(500).json({ ok:false, error: String(e.message || e) });
  }
}
