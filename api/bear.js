import { getJson, KEYS } from "./_store.js";
export default async function handler(req,res){
  const data = await getJson(KEYS.bear, null);
  if(!data) return res.status(404).json({ error:"no data yet - run /api/scan once" });
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(data);
}
