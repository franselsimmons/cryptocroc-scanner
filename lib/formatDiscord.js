// lib/formatDiscord.js
function fmtNum(x, max = 8) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(max).replace(/\.?0+$/, "");
}

function formatTpSl(t) {
  if (!t) return "";
  const tp = t.tp != null ? fmtNum(t.tp) : "-";
  const sl = t.sl != null ? fmtNum(t.sl) : "-";
  const rr = t.rr != null ? fmtNum(t.rr, 2) : "-";
  return `TP: ${tp} • SL: ${sl} • RR: ${rr}`;
}

export function formatSignalMessage({ source, stage, mode, coin, btcState, kind, pnl, reason }) {
  const symbol = coin?.symbol || "?";
  const price = fmtNum(coin?.price);
  const conf = coin?.confidence ?? coin?.entryQuality ?? "-";
  const ch1h = coin?.change1h != null ? `${fmtNum(coin.change1h, 3)}%` : "-";
  const ch24 = coin?.change24 != null ? `${fmtNum(coin.change24, 3)}%` : "-";
  const spread = coin?.ob?.spreadPct != null ? fmtNum(coin.ob.spreadPct, 3) : "-";
  const depth = coin?.ob?.depthMinUsd1p != null ? fmtNum(coin.ob.depthMinUsd1p, 0) : "-";
  const obScore = coin?.ob?.score != null ? fmtNum(coin.ob.score, 5) : "-";
  const tradePlan = coin?.tradePlan || {};

  const lines = [
    `**${source?.toUpperCase()} • ${mode?.toUpperCase()} • ${stage}**`,
    `**${symbol}**`,
    `Prijs: ${price}`,
  ];

  if (kind === "trade_opened") {
    lines.push(formatTpSl(tradePlan));
    lines.push(`Conf: ${conf} • BTC: ${btcState || "-"}`);
    lines.push(`1h: ${ch1h} • 24h: ${ch24}`);
    lines.push(`Spread: ${spread}% • Depth: ${depth} • OB: ${obScore}`);
  } else if (kind === "trade_closed") {
    lines.push(`PnL: ${pnl != null ? fmtNum(pnl, 2) : "-"}%`);
    lines.push(`Reden: ${reason || "-"}`);
    if (tradePlan.entry) lines.push(`Entry: ${fmtNum(tradePlan.entry)}`);
  } else {
    // generic signal
    lines.push(formatTpSl(tradePlan));
    lines.push(`Conf: ${conf} • BTC: ${btcState || "-"}`);
  }

  return lines.join("\n");
}