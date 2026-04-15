const trades = new Map();

export function handleTrade(coin){

  const key = coin.symbol;

  // ================= ENTRY =================
  if(coin.stage === "ENTRY" && !trades.has(key)){

    const trade = {
      symbol: key,
      entry: coin.price,
      sl: coin.price * 0.97,
      tp: coin.price * 1.06,
      status: "OPEN",
      openedAt: Date.now()
    };

    trades.set(key, trade);
    return trade;
  }

  const trade = trades.get(key);
  if(!trade) return null;

  // ================= EXIT =================
  if(trade.status === "OPEN"){

    if(coin.price <= trade.sl){
      trade.status = "STOPPED";
    }

    if(coin.price >= trade.tp){
      trade.status = "TAKE_PROFIT";
    }

    // fallback exit
    if(coin.stage === "RADAR"){
      trade.status = "EXIT_WEAK";
    }
  }

  return trade;
}

export function getAllTrades(){
  return Array.from(trades.values());
}