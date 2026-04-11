import { kv } from "@vercel/kv";
import WebSocket from 'ws';
import { executeBitgetOrder, queueDiscordEvent, syncExchangePositions, initializeAccountMode } from "./_trade_engine.js";
import { entryTriggerOk, hardBreakDetected } from "./_trade_engine_core.js";

let localPositions = { open:, closed: };
let liveMarketData = {};

function initBitgetWebSocket() {
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");
  ws.on('open', () => {
    ws.send(JSON.stringify({ 
      op: "subscribe", 
      args: 
    }));
  });

  ws.on('message', (data) => {
    const parsed = JSON.parse(data);
    if (!parsed.data ||!parsed.arg) return;
    
    // Zorg ervoor dat Bitget array messages correct genavigeerd worden
    const payload = Array.isArray(parsed.data)? parsed.data : parsed.data;
    if (!payload) return;

    const sym = parsed.arg.instId.replace("USDT", "");
    if (!liveMarketData[sym]) liveMarketData[sym] = { price: 0, spreadPct: 999, obScore: 0 };
    
    if (parsed.arg.channel === "ticker") {
        liveMarketData[sym].price = parseFloat(payload.lastPr);
    } else if (parsed.arg.channel === "books15") {
        const bids = payload.bids;
        const asks = payload.asks;
        if (bids && asks && bids.length > 0 && asks.length > 0) {
            const bestBid = parseFloat(bids);
            const bestAsk = parseFloat(asks);
            liveMarketData[sym].price = (bestBid + bestAsk) / 2;
            liveMarketData[sym].spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
            
            const bVol = bids.reduce((acc, v) => acc + (parseFloat(v) * parseFloat(v[1])), 0);
            const aVol = asks.reduce((acc, v) => acc + (parseFloat(v) * parseFloat(v[1])), 0);
            liveMarketData[sym].obScore = (bVol - aVol) / (bVol + aVol);
        }
    }
  });
}

async function runEngineLoop(mode) {
  try {
    // Specifieke lock per mode (bijv. bull en bear vechten nooit om de lock)
    const locked = await kv.set(`engine:lock:${mode}`, Date.now(), { nx: true, ex: 5 });
    if (!locked) return; 

    let candidates = await kv.get(`engine:candidates:${mode}`) ||;
    let stateChanged = false;
    let candidatesChanged = false;

    // 1. POSITION MANAGEMENT
    for (let i = localPositions.open.length - 1; i >= 0; i--) {
      const pos = localPositions.open[i];
      if (pos.sourceMode!== mode) continue;

      const liveData = liveMarketData[pos.symbol];
      if (!liveData ||!liveData.price) continue;

      const isShort = pos.side === "SHORT";
      const grossPnl = isShort? ((pos.entryPrice - liveData.price) / pos.entryPrice) * 100 
                               : ((liveData.price - pos.entryPrice) / pos.entryPrice) * 100;
      const netPnlPct = grossPnl - 0.12; 

      let exitReason = null;

      if (netPnlPct <= -pos.slPct) exitReason = "hard_stop_loss";

      if (!exitReason && pos.system === "moon") {
        if (netPnlPct >= 3.0) { 
          pos.trailingActive = true;
          pos.hwm = isShort? Math.min(pos.hwm |

| pos.entryPrice, liveData.price) : Math.max(pos.hwm |
| pos.entryPrice, liveData.price);
        }
        if (pos.trailingActive) {
          const trailStopPrice = isShort? pos.hwm * 1.015 : pos.hwm * 0.985;
          if ((isShort && liveData.price >= trailStopPrice) |

| (!isShort && liveData.price <= trailStopPrice)) {
            exitReason = "trailing_stop_hit";
          }
        }
      }

      if (!exitReason && pos.system === "main" && netPnlPct >= pos.tpPct) exitReason = "tp_hit";

      if (!exitReason) {
        const breakCheck = hardBreakDetected({ side: pos.side, obScore: liveData.obScore, spreadPct: liveData.spreadPct, obContraExtremeAbs: 0.05, maxSpreadPctInTrade: 1.45 });
        if (breakCheck.hit) exitReason = breakCheck.reason;
      }

      if (exitReason) {
        const fill = await executeBitgetOrder("CLOSE", pos.symbol, pos.size, pos.side);
        if (fill.success) {
          localPositions.closed.push({...pos, exitReason, netPnlPct, exitPrice: fill.price});
          localPositions.open.splice(i, 1);
          stateChanged = true;
          queueDiscordEvent(2, "TRADE_CLOSED", pos.symbol, { reason: exitReason, pnl: netPnlPct });
        }
      }
    }

    // 2. CANDIDATE LIFECYCLE (Main Ticket Flow + Moon Direct Entry)
    const activeOpen = localPositions.open.filter(p => p.sourceMode === mode).length;
    if (activeOpen < 2) {
      for (let cand of candidates) {
        if (cand.lifecycleState === "OPENED" |

| cand.lifecycleState === "CANCELLED") continue;
        const liveData = liveMarketData[cand.symbol];
        if (!liveData) continue;

        let executeNow = false;

        if (cand.engineGate === "OPEN") {
            executeNow = true;
        } 
        else if (cand.engineGate === "WATCH" && cand.sourceSystem === "main") {
            if (cand.lifecycleState === "WATCH") {
                cand.lifecycleState = "ARM_ENTRY";
                candidatesChanged = true;
            }
            if (cand.lifecycleState === "ARM_ENTRY" && liveData.spreadPct < 1.1) {
                cand.lifecycleState = "PENDING_ENTRY";
                candidatesChanged = true;
            }
            if (cand.lifecycleState === "PENDING_ENTRY") {
                const triggerOk = entryTriggerOk({
                    side: cand.side, price: liveData.price, entry: cand.tradePlan.entry,
                    spreadPct: liveData.spreadPct, maxSpreadPct: 1.25, obScore: liveData.obScore
                });
                if (triggerOk) {
                    cand.lifecycleState = "ALLOW_ENTRY";
                    candidatesChanged = true;
                    executeNow = true;
                }
            }
        }

        if (executeNow) {
          const clientOid = `ENT_${cand.symbol}_${Date.now()}`;
          const fill = await executeBitgetOrder("OPEN", cand.symbol, cand.tradePlan.size, cand.side, clientOid);
          
          if (fill.success) {
            localPositions.open.push({
              id: clientOid, sourceMode: mode, system: cand.sourceSystem, symbol: cand.symbol,
              side: cand.side, size: cand.tradePlan.size, entryPrice: fill.price,
              slPct: cand.tradePlan.slPct, tpPct: cand.tradePlan.tpPct, hwm: fill.price
            });
            cand.lifecycleState = "OPENED"; 
            stateChanged = true;
            candidatesChanged = true;
            queueDiscordEvent(2, "TRADE_OPENED", cand.symbol, { price: fill.price, side: cand.side, system: cand.sourceSystem });
            break; 
          } else {
             cand.lifecycleState = "CANCELLED";
             candidatesChanged = true;
          }
        }
      }
    }

    if (candidatesChanged) await kv.set(`engine:candidates:${mode}`, candidates.filter(c => c.lifecycleState!== "OPENED" && c.lifecycleState!== "CANCELLED"));
    if (stateChanged) await kv.set("portfolio:positions:global", localPositions);

  } catch (err) {
    console.error(`Engine ${mode} error:`, err);
  } finally {
    await kv.del(`engine:lock:${mode}`);
    setTimeout(() => runEngineLoop(mode), 1000); 
  }
}

async function init() {
  await initializeAccountMode();
  initBitgetWebSocket();
  
  const actualPositions = await syncExchangePositions();
  if (actualPositions && actualPositions.length > 0) {
      localPositions.open = actualPositions;
  }
  
  // Start de loops los van elkaar (geen overlap op zelfde mode door de locks)
  setTimeout(() => runEngineLoop("bull"), 1000);
  setTimeout(() => runEngineLoop("bear"), 1500); 
}
init();
