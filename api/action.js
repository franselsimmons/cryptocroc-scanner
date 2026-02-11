export default async function handler(req, res) {
  res.status(400).json({
    ok:false,
    error:"/api/action is disabled on Vercel Free without persistent storage.",
    fix:"Gebruik Upstash (gratis) of Vercel KV om OPEN/CLOSE persistent te maken."
  });
}
