import { ensurePortfolio, getJson, KEYS } from "./_store.js";
export default async function handler(req,res){
  await ensurePortfolio();
  const t = await getJson(KEYS.trades, []);
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(t);
}
