import scan from "./scan.js";
export default async function handler(req){
  // backward compat: /api/top10_bear = bear scan
  const u = new URL(req.url);
  u.searchParams.set("side","bear");
  return scan(new Request(u.toString(), { method:"GET" }));
}
