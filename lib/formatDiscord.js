const fmtNum = (x) => Number(x)?.toFixed(4).replace(/\.?0+$/, "") || "-";
const fmtPct = (x) => (x > 0 ? "+" : "") + Number(x)?.toFixed(2) + "%";

export function getDiscordColor({ kind, pnl, reason }) {
  if (kind === "trade_opened") return 3447003; // Blauw
  if (kind === "trade_closed") return pnl >= 0 ? 5763719 : 15548997; // Groen of Rood
  return 3066993; // Default grijs/blauw
}

export function formatSignalMessage({ source, stage, mode, coin, btcState, kind, pnl, reason }) {
  const symbol = up(coin?.symbol);
  const price = fmtNum(coin?.price);
  
  let rows = [
    `**${up(source)} • ${up(mode)} • ${up(stage)}**`,
    "",
    kind === "trade_opened" ? `🟢 **TRADE OPENED — ${symbol}**` : 
    kind === "trade_closed" ? `🔴 **TRADE CLOSED — ${symbol}**` : `👀 **RADAR — ${symbol}**`,
    `Prijs: **${price}**`,
    `₿ BTC: ${btcState || "Stable"}`,
    reason ? `📝 ${reason}` : ""
  ];

  if (pnl != null) rows.push(`📊 Resultaat: ${fmtPct(pnl)}`);
  
  return rows.filter(Boolean).join("\n");
}

function up(x) { return String(x || "").toUpperCase(); }
