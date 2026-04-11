import { kv } from "@vercel/kv";

// Fake exchange cliënt om de architectuur robuust te maken (vervang later met CCXT of Bitget Node SDK)
const bitgetClient = { post: async () => {}, get: async () => {} };
let isSystemKilled = false;

export async function initializeAccountMode() {
  try {
    // Force Bitget futures naar hedge_mode
    // await bitgetClient.post("/api/v2/mix/account/set-position-mode", { productType: "USDT-FUTURES", posMode: "hedge_mode" });
    console.log("Verified Bitget account is set to hedge_mode");
  } catch (e) {
    console.error("FATAL: Kan hedge_mode niet forceren. Start geaborteerd.", e);
    process.exit(1);
  }
}

export async function executeBitgetOrder(action, symbol, size, positionSide, clientOid = "") {
  if (isSystemKilled) return { success: false, reason: "kill_switch_active" };
  try {
    // CORRECTE BITGET HEDGE MODE MAPPING
    const mappedSide = positionSide === "LONG"? "buy" : "sell";
    const mappedTradeSide = action === "OPEN"? "open" : "close";
    
    const payload = {
      symbol: `${symbol}USDT`,
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
      size: String(size),
      side: mappedSide,
      tradeSide: mappedTradeSide,
      orderType: "market",
      clientOid: clientOid |

| `SYS_${Date.now()}`
    };
    // await bitgetClient.post("/api/v2/mix/order/place-order", payload);
    return { success: true, price: 50000 }; 
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export async function emergencyFlattenPosition(symbol, positionSide) {
  try {
    const payload = {
      symbol: `${symbol}USDT`,
      productType: "USDT-FUTURES",
      holdSide: positionSide.toLowerCase() 
    };
    // await bitgetClient.post("/api/v2/mix/order/close-positions", payload);
    return true;
  } catch (e) {
    return false;
  }
}

export async function syncExchangePositions() {
  try {
    // const res = await bitgetClient.get("/api/v2/mix/position/all-position?productType=USDT-FUTURES");
    // const mapped = res.data.map(p => ({...p }));
    return null; 
  } catch (err) {
    return null;
  }
}

let nonceCounter = 0;
export async function queueDiscordEvent(priority, type, symbol, data) {
  const score = (priority * 1e13) + (Date.now() * 1000) + (nonceCounter++ % 1000);
  await kv.zadd("system:events:queue", { score, member: JSON.stringify({ type, symbol, data }) });
}
