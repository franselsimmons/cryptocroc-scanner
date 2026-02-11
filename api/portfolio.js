import { ensurePortfolio, getJson, KEYS } from "./_store.js";
export default async function handler(req,res){
  await ensurePortfolio();
  const p = await getJson(KEYS.portfolio, {});
  res.setHeader("Cache-Control","no-store");
  return res.status(200).json(p);
}
