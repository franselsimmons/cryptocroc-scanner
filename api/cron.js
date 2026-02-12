import scan from "./scan.js";

export const config = { runtime: "nodejs" };

export default async function handler(req,res){
  try{
    const secret = process.env.CRON_SECRET;
    if(secret){
      const auth = req.headers.authorization;
      if(auth !== `Bearer ${secret}`){
        res.statusCode=401;
        res.end("Unauthorized");
        return;
      }
    }

    await scan({url:"/api/scan?mode=bull"}, {statusCode:200,setHeader(){},end(){}});
    await scan({url:"/api/scan?mode=bear"}, {statusCode:200,setHeader(){},end(){}});

    res.statusCode=200;
    res.end(JSON.stringify({ok:true}));
  }catch(e){
    res.statusCode=500;
    res.end(String(e));
  }
}