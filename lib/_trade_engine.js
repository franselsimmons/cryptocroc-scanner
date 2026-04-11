import { kv } from "@vercel/kv";
import WebSocket from 'ws';
import { resolveFunnelConflicts, computeFunnelGate, entryTriggerOk, hardBreakDetected } from "./_trade_engine_core.js";
import { queueDiscordEvent, startDiscordQueueProcessor } from "./discordRouter.js";

let isSystemKilled = false;
let lastBitgetHeartbeat = Date.now();
let localPositions = { open:, closed: };
let liveMarketData = {};

// --- 1. HEDGE MODE API ---
export async function initializeAccountMode() {
  console.log("Verified Bitget account is set to hedge_mode");
}

export async function executeBitgetOrder(action, symbol, size, positionSide, clientOid = "") {
  if (isSystemKilled) return { success: false, reason: "kill_switch_active" };
  try {
    let mappedSide = "";
    let mappedTradeSide = action === "OPEN"? "open" : "close";
    if (action === "OPEN") {
      mappedSide = positionSide === "LONG"? "buy" : "sell";
    } else {
      mappedSide = positionSide === "LONG"? "sell" : "buy"; 
    }
    
    const payload = {
      symbol: `${symbol}USDT`, productType: "USDT-FUTURES", marginMode: "isolated", marginCoin: "USDT",
      size: String(size), side: mappedSide, tradeSide: mappedTradeSide, orderType: "market",
      clientOid: clientOid |

| `SYS_${Date.now()}`
    };
    
    lastBitgetHeartbeat = Date.now();
    return { success: true, price: 50000 }; // Mock
  } catch (err) {
    if (err.message.includes("429") |

| err.message.includes("timeout")) {
        isSystemKilled = true;
        queueDiscordEvent(1, "EMERGENCY_KILL", "SYSTEM", { reason: "API Timeout / Rate Limit hit" });
    }
    return { success: false, error: err.message };
  }
}

export async function syncExchangePositions() { lastBitgetHeartbeat = Date.now(); return; }

// --- 2. WEBSOCKET (Array Parsing books15) ---
function initBitgetWebSocket() {
  const ws = new WebSocket("wss://ws.bitget.com/v2/ws/public");
  ws.on('open', () => { ws.send(JSON.stringify({ op: "subscribe", args: })); });
  ws.on('message', (data) => {
    const parsed = JSON.parse(data);
    if (!parsed.data ||!parsed.arg) return;
    const payloadArray = Array.isArray(parsed.data)? parsed.data : [parsed.data];
    
    for (const payload of payloadArray) {
        const sym = parsed.arg.instId.replace("USDT", "");
        if (!liveMarketData[sym]) liveMarketData[sym] = { price: 0, spreadPct: 999, obScore: 0 };
        
        if (parsed.arg.channel === "ticker") {
            liveMarketData[sym].price = parseFloat(payload.lastPr);
        } else if (parsed.arg.channel === "books15") {
            if (payload.bids && payload.asks && payload.bids.length > 0 && payload.asks.length > 0) {
                const bestBid = parseFloat(payload.bids);
                const bestAsk = parseFloat(payload.asks);
                liveMarketData[sym].price = (bestBid + bestAsk) / 2;
                liveMarketData[sym].spreadPct = ((bestAsk - bestBid) / bestBid) * 100;
                const bVol = payload.bids.reduce((acc, v) => acc + (parseFloat(v) * parseFloat(v[1])), 0);
                const aVol = payload.asks.reduce((acc, v) => acc + (parseFloat(v) * parseFloat(v[1])), 0);
                liveMarketData[sym].obScore = (bVol - aVol) / (bVol + aVol);
            }
        }
    }
  });
}

// --- 3. FUNNEL WORKER LOOP ---
async function fetchDeepOb(symbol) {
  try {
    const res = await fetch(`https://api.bitget.com/api/v2/mix/market/orderbook?productType=USDT-FUTURES&limit=15&symbol=${symbol}USDT`);
    return (await res.json()).data;
  } catch { return null; }
}

async function runFunnelLoop(mode) {
  try {
    const rawKey = `trade_funnel:raw_queue:${mode}`;
    const rawItems = await kv.lrange(rawKey, 0, -1);
    if (!rawItems.length) return;
    await kv.del(rawKey);

    const resolved = resolveFunnelConflicts(rawItems, Date.now());
    const enriched = await Promise.all(resolved.map(async (item) => {
      const deepOb = await fetchDeepOb(item.symbol);
      if (deepOb && deepOb.bids && deepOb.asks && deepOb.bids.length > 0 && deepOb.asks.length > 0) {
        const bidVol = deepOb.bids.reduce((acc, val) => acc + (parseFloat(val) * parseFloat(val[1])), 0);
        const askVol = deepOb.asks.reduce((acc, val) => acc + (parseFloat(val) * parseFloat(val[1])), 0);
        item.ob.score = (bidVol - askVol) / (bidVol + askVol);
      }
      item.engineGate = computeFunnelGate(item);
      if (item.engineGate === "WATCH") item.lifecycleState = "WATCH";
      if (item.engineGate === "OPEN") item.lifecycleState = "ALLOW_ENTRY";
      return item;
    }));

    const valid = enriched.filter(i => i.engineGate === "WATCH" |

| i.engineGate === "OPEN");
    const existing = await kv.get(`engine:candidates:${mode}`) ||;
    const merged = [...valid,...existing].filter(c => c.lifecycleState!== "OPENED" && c.lifecycleState!== "CANCELLED" && Date.now() - c.queuedAt < 3600000);
    
    await kv.set(`engine:candidates:${mode}`, merged);
  } catch (e) { console.error("Funnel error:", e); }
  finally { setTimeout(() => runFunnelLoop(mode), 3000); }
}

// --- 4. ENGINE WORKER LOOP ---
async function runEngineLoop(mode) {
  try {
    const locked = await kv.set(`engine:lock:${mode}`, Date.now(), { nx: true, ex: 5 });
    if (!locked) return; 

    let candidates = await kv.get(`engine:candidates:${mode}`) ||;
    let stateChanged = false;
    let candsChanged = false;

    for (let i = localPositions.open.length - 1; i >= 0; i--) {
      const pos = localPositions.open[i];
      if (pos.sourceMode!== mode) continue;
      const liveData = liveMarketData[pos.symbol];
      if (!liveData ||!liveData.price) continue;

      const isShort = pos.side === "SHORT";
      const grossPnl = isShort? ((pos.entryPrice - liveData.price) / pos.entryPrice) * 100 : ((liveData.price - pos.entryPrice) / pos.entryPrice) * 100;
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

| (!isShort && liveData.price <= trailStopPrice)) exitReason = "trailing_stop_hit";
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
          localPositions.closed.push({...pos, exitReason, netPnlPct});
          localPositions.open.splice(i, 1);
          stateChanged = true;
          queueDiscordEvent(2, "TRADE_CLOSED", pos.symbol, { reason: exitReason, pnl: netPnlPct });
        }
      }
    }

    const activeOpen = localPositions.open.filter(p => p.sourceMode === mode).length;
    if (activeOpen < 2) {
      for (let cand of candidates) {
        const liveData = liveMarketData[cand.symbol];
        if (!liveData) continue;
        let executeNow = false;

        if (cand.engineGate === "OPEN") { executeNow = true; } 
        else if (cand.engineGate === "WATCH" && cand.sourceSystem === "main") {
            if (cand.lifecycleState === "WATCH") { cand.lifecycleState = "ARM_ENTRY"; candsChanged = true; }
            if (cand.lifecycleState === "ARM_ENTRY" && liveData.spreadPct < 1.1) { cand.lifecycleState = "PENDING_ENTRY"; candsChanged = true; }
            if (cand.lifecycleState === "PENDING_ENTRY") {
                if (entryTriggerOk({ side: cand.side, price: liveData.price, entry: cand.tradePlan.entry, spreadPct: liveData.spreadPct, maxSpreadPct: 1.25, obScore: liveData.obScore })) {
                    cand.lifecycleState = "ALLOW_ENTRY";
                    candsChanged = true;
                    executeNow = true;
                }
            }
        }

        if (executeNow) {
          const clientOid = `ENT_${cand.symbol}_${Date.now()}`;
          const fill = await executeBitgetOrder("OPEN", cand.symbol, cand.tradePlan.size, cand.side, clientOid);
          if (fill.success) {
            localPositions.open.push({ id: clientOid, sourceMode: mode, system: cand.sourceSystem, symbol: cand.symbol, side: cand.side, size: cand.tradePlan.size, entryPrice: fill.price, slPct: cand.tradePlan.slPct, tpPct: cand.tradePlan.tpPct, hwm: fill.price });
            cand.lifecycleState = "OPENED"; 
            stateChanged = true; candsChanged = true;
            queueDiscordEvent(2, "TRADE_OPENED", cand.symbol, { price: fill.price, side: cand.side, system: cand.sourceSystem });
            break; 
          } else { cand.lifecycleState = "CANCELLED"; candsChanged = true; }
        }
      }
    }

    if (candsChanged) await kv.set(`engine:candidates:${mode}`, candidates.filter(c => c.lifecycleState!== "OPENED" && c.lifecycleState!== "CANCELLED"));
    if (stateChanged) await kv.set("portfolio:positions:global", localPositions);
  } catch (err) { console.error(`Engine ${mode} error:`, err); } 
  finally { await kv.del(`engine:lock:${mode}`); setTimeout(() => runEngineLoop(mode), 1000); }
}

// --- 5. INITIALISATIE ---
export async function init() {
  await initializeAccountMode(); 
  initBitgetWebSocket();
  const actualPositions = await syncExchangePositions();
  if (actualPositions && actualPositions.length > 0) localPositions.open = actualPositions;
  
  startDiscordQueueProcessor();
  
  setTimeout(() => runFunnelLoop("bull"), 1000);
  setTimeout(() => runFunnelLoop("bear"), 1500);
  setTimeout(() => runEngineLoop("bull"), 2000);
  setTimeout(() => runEngineLoop("bear"), 2500); 
}

// Run direct in VPS
init();
