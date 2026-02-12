import scan from "./scan.js";
export default async function handler(req){
  // backward compat: /api/top10 = bull scan
  const u = new URL(req.url);
  u.searchParams.set("side","bull");
  return scan(new Request(u.toString(), { method:"GET" }));
}
