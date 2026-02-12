import scan from "./scan.js";

export const config = { runtime: "nodejs" };

function mkReq(mode){
  return { url: `/api/scan?mode=${mode}` };
}
function mkRes(){
  return {
    statusCode: 200,
    headers: {},
    setHeader(k,v){ this.headers[k]=v; },
    end(){},
  };
}

export default async function handler(req, res){
  try{
    // Optioneel: beveilig cron met CRON_SECRET
    const secret = process.env.CRON_SECRET;
    if(secret){
      const auth = req.headers?.authorization || req.headers?.Authorization || "";
      if(auth !== `Bearer ${secret}`){
        res.statusCode = 401;
        res.setHeader("content-type","application/json; charset=utf-8");
        res.end(JSON.stringify({ error:"Unauthorized" }));
        return;
      }
    }

    // Bull scan
    await scan(mkReq("bull"), mkRes());
    // Bear scan
    await scan(mkReq("bear"), mkRes());

    res.statusCode = 200;
    res.setHeader("content-type","application/json; charset=utf-8");
    res.end(JSON.stringify({ ok:true, ts: Date.now() }));
  }catch(e){
    res.statusCode = 500;
    res.setHeader("content-type","application/json; charset=utf-8");
    res.end(JSON.stringify({ error:String(e?.message||e) }));
  }
}
