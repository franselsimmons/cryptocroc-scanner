import { ensurePortfolio, getJson, setJson, pushTrade, KEYS } from "./_store.js";

function ddPct(port){
  const peak = Number(port?.peakBalance ?? port?.currentBalance ?? 0);
  const cur  = Number(port?.currentBalance ?? 0);
  if(peak<=0) return 0;
  return ((cur-peak)/peak)*100;
}

export default async function handler(req,res){
  res.setHeader("Cache-Control","no-store");
  if(req.method !== "POST") return res.status(405).json({ ok:false, error:"POST only" });

  const body = req.body || {};
  await ensurePortfolio();
  const port = await getJson(KEYS.portfolio, null);
  if(!port) return res.status(500).json({ ok:false, error:"portfolio missing" });

  try{
    if(body.action==="OPEN"){
      const price = Number(body.entryPrice);
      const sizePct = Number(body.sizePct);
      const stopPct = Number(body.stopPct);

      if(!Number.isFinite(price) || price<=0) throw new Error("entryPrice ongeldig");
      if(!Number.isFinite(sizePct) || sizePct<=0) throw new Error("sizePct ongeldig");
      if(!Number.isFinite(stopPct) || stopPct>=0) throw new Error("stopPct moet negatief zijn");

      const dd = ddPct(port);
      if(dd <= (port.maxDrawdownPct ?? -8)) throw new Error("DD kill switch actief");

      const positions = Array.isArray(port.positions) ? port.positions : [];
      const open = positions.filter(p=>p.isOpen);

      const openExpl = open.filter(p=>p.engine==="EXPLOSIE").length;
      const openAcc  = open.filter(p=>p.engine==="ACCUMULATIE").length;

      if(body.engine==="EXPLOSIE" && openExpl >= (port.maxOpenExplosie ?? 2)) throw new Error("Max EXPLOSIE trades bereikt");
      if(body.engine==="ACCUMULATIE" && openAcc >= (port.maxOpenAccu ?? 3)) throw new Error("Max ACCUMULATIE trades bereikt");

      const openRiskPct = (sizePct * Math.abs(stopPct)) / 100;
      const totalOpenRiskPct = open.reduce((s,p)=> s + (Number(p.openRiskPct)||0), 0);
      const maxTotal = Number(port.maxTotalOpenRiskPct ?? 4);

      if(totalOpenRiskPct + openRiskPct > maxTotal){
        throw new Error(`Max open risk overschreden (${(totalOpenRiskPct+openRiskPct).toFixed(2)}% > ${maxTotal}%)`);
      }

      const id = "pos_" + Math.random().toString(16).slice(2) + "_" + Date.now();
      const pos = {
        id,
        tsOpen: new Date().toISOString(),
        symbol: String(body.symbol||"").toUpperCase(),
        side: body.side,
        engine: body.engine,
        entryPrice: price,
        sizePct,
        stopPct,
        tp1Pct: Number(body.tp1Pct),
        beAtPct: Number(body.beAtPct),
        openRiskPct: Number(openRiskPct.toFixed(3)),
        isOpen: true
      };

      port.positions = positions.concat([pos]);
      port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), Number(port.currentBalance ?? 0));

      await setJson(KEYS.portfolio, port);
      await pushTrade({ type:"OPEN", ...pos });

      return res.status(200).json({ ok:true, portfolio:port });
    }

    if(body.action==="CLOSE"){
      const id = String(body.id||"");
      const exitPrice = Number(body.exitPrice);
      if(!id) throw new Error("id ontbreekt");
      if(!Number.isFinite(exitPrice) || exitPrice<=0) throw new Error("exitPrice ongeldig");

      const positions = Array.isArray(port.positions) ? port.positions : [];
      const idx = positions.findIndex(p=>p.id===id && p.isOpen);
      if(idx<0) throw new Error("Open positie niet gevonden");

      const p = positions[idx];
      const entry = Number(p.entryPrice);
      const dir = (p.side==="BULL") ? 1 : -1;

      const pnlPct = ((exitPrice-entry)/entry)*100*dir;
      const impactPct = (Number(p.sizePct) * pnlPct) / 100;

      const cur = Number(port.currentBalance ?? 0);
      const newBal = cur * (1 + impactPct/100);

      positions[idx] = { ...p,
        tsClose:new Date().toISOString(),
        exitPrice,
        pnlPct:Number(pnlPct.toFixed(3)),
        accountImpactPct:Number(impactPct.toFixed(3)),
        isOpen:false
      };

      port.positions = positions;
      port.currentBalance = Number(newBal.toFixed(2));
      port.peakBalance = Math.max(Number(port.peakBalance ?? port.currentBalance ?? 0), port.currentBalance);

      await setJson(KEYS.portfolio, port);
      await pushTrade({ type:"CLOSE", id, symbol:p.symbol, side:p.side, engine:p.engine, entryPrice:entry, exitPrice, pnlPct:Number(pnlPct.toFixed(3)), accountImpactPct:Number(impactPct.toFixed(3)), ts:new Date().toISOString() });

      return res.status(200).json({ ok:true, portfolio:port });
    }

    return res.status(400).json({ ok:false, error:"Unknown action" });
  }catch(e){
    return res.status(400).json({ ok:false, error:String(e.message||e) });
  }
}
