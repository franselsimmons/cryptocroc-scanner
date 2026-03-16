// lib/formatDiscord.js
function fmtNum(x, max = 8) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(max).replace(/\.?0+$/, "");
}

function fmtPct(x, max = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(max).replace(/\.?0+$/, "")}%`;
}

function fmtUsd(x, max = 2) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return `$${v.toFixed(max).replace(/\.?0+$/, "")}`;
}

function upper(x) {
  return String(x || "").toUpperCase();
}

function sourceLabel(source) {
  const s = String(source || "").toLowerCase();
  if (s === "main") return "Main";
  if (s === "moon") return "Moon";
  return s || "Signal";
}

function modeLabel(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === "bull") return "LONG";
  if (m === "bear") return "SHORT";
  return upper(mode);
}

function stageLabel(stage) {
  return String(stage || "UNKNOWN")
    .replaceAll("_", " ")
    .toUpperCase();
}

function formatTpSl(t) {
  if (!t) return "";
  const tp = t.tp != null ? fmtNum(t.tp) : "-";
  const sl = t.sl != null ? fmtNum(t.sl) : "-";
  const rr = t.rr != null ? fmtNum(t.rr, 2) : "-";
  return `🎯 TP ${tp} • 🛡️ SL ${sl} • ⚖️ RR ${rr}`;
}

function getEntryValue(coin) {
  if (coin?.tradePlan?.entry != null) return coin.tradePlan.entry;
  if (coin?.entryPrice != null) return coin.entryPrice;
  return null;
}

function getTpValue(coin) {
  if (coin?.tradePlan?.tp != null) return coin.tradePlan.tp;
  if (coin?.tp != null) return coin.tp;
  return null;
}

function getSlValue(coin) {
  if (coin?.tradePlan?.sl != null) return coin.tradePlan.sl;
  if (coin?.sl != null) return coin.sl;
  return null;
}

function getRrValue(coin) {
  if (coin?.tradePlan?.rr != null) return coin.tradePlan.rr;
  if (coin?.rr != null) return coin.rr;
  return null;
}

function getDirectionText(mode) {
  return String(mode || "").toLowerCase() === "bear" ? "short setup" : "long setup";
}

function getPnlMood(pnl) {
  const v = Number(pnl);
  if (!Number.isFinite(v)) return "vlak";
  if (v >= 8) return "sterk in profit";
  if (v >= 3) return "netjes in profit";
  if (v > 0) return "licht in profit";
  if (v <= -8) return "stevig onder druk";
  if (v <= -3) return "onder druk";
  if (v < 0) return "licht rood";
  return "vlak";
}

function cleanReason(reason) {
  if (!reason) return "-";

  const r = String(reason);

  if (r === "take_profit") return "take profit geraakt";
  if (r === "stop_loss") return "stop loss geraakt";
  if (r === "thesis_break") return "setup verloor kracht";
  if (r === "timeout") return "setup duurde te lang zonder follow-through";

  if (r.startsWith("Thesis damage")) return r;
  if (r.startsWith("Position update")) return r;

  return r;
}

export function formatSignalMessage({
  source,
  stage,
  mode,
  coin,
  btcState,
  kind,
  pnl,
  reason,
}) {
  const symbol = coin?.symbol || "?";
  const price = fmtNum(coin?.price);
  const conf = coin?.entryQuality ?? coin?.confidence ?? "-";
  const ch1h = coin?.change1h != null ? fmtPct(coin.change1h, 2) : "-";
  const ch24 = coin?.change24 != null ? fmtPct(coin.change24, 2) : "-";
  const spread = coin?.ob?.spreadPct != null ? `${fmtNum(coin.ob.spreadPct, 3)}%` : "-";
  const depth = coin?.ob?.depthMinUsd1p != null ? fmtUsd(coin.ob.depthMinUsd1p, 0) : "-";
  const obScore = coin?.ob?.score != null ? fmtNum(coin.ob.score, 5) : "-";

  const entry = getEntryValue(coin);
  const tp = getTpValue(coin);
  const sl = getSlValue(coin);
  const rr = getRrValue(coin);

  const tradePlan = {
    entry,
    tp,
    sl,
    rr,
  };

  const header = `**${sourceLabel(source)} • ${modeLabel(mode)} • ${stageLabel(stage)}**`;

  if (kind === "trade_opened") {
    const lines = [
      header,
      ``,
      `🚨 **Nieuwe trade geopend op ${symbol}**`,
      `We hebben deze ${getDirectionText(mode)} geopend rond **${price}**.`,
      formatTpSl(tradePlan),
      `📍 Entry ${entry != null ? fmtNum(entry) : price}`,
      `📊 Kwaliteit ${conf} • BTC ${btcState || "-"}`,
      `📈 1u ${ch1h} • 24u ${ch24}`,
      `🌊 Spread ${spread} • Depth ${depth} • OB ${obScore}`,
    ];

    return lines.filter(Boolean).join("\n");
  }

  if (kind === "trade_closed") {
    const pnlText = pnl != null ? fmtPct(pnl, 2) : "-";
    const why = cleanReason(reason);

    const lines = [
      header,
      ``,
      `✅ **Trade gesloten op ${symbol}**`,
      `Resultaat: **${pnlText}**`,
      `Reden: ${why}`,
    ];

    if (entry != null) {
      lines.push(`📍 Entry was ${fmtNum(entry)}`);
    }

    if (coin?.price != null) {
      lines.push(`💰 Exit rond ${fmtNum(coin.price)}`);
    }

    return lines.filter(Boolean).join("\n");
  }

  if (kind === "position_update") {
    const pnlText = pnl != null ? fmtPct(pnl, 2) : "-";
    const why = cleanReason(reason);
    const mood = getPnlMood(pnl);

    const lines = [
      header,
      ``,
      `📌 **Update voor ${symbol}**`,
      `De positie staat nu op **${pnlText}** en oogt momenteel **${mood}**.`,
      `Prijs nu: ${price}`,
    ];

    if (why && why !== "-") {
      lines.push(`Notitie: ${why}`);
    }

    if (entry != null) {
      lines.push(`📍 Entry ${fmtNum(entry)}`);
    }

    if (tp != null || sl != null || rr != null) {
      lines.push(formatTpSl(tradePlan));
    }

    lines.push(`📊 BTC ${btcState || "-"} • 1u ${ch1h} • 24u ${ch24}`);

    return lines.filter(Boolean).join("\n");
  }

  // gewone funnel signalen
  const lines = [
    header,
    ``,
    `👀 **${symbol} staat op de radar**`,
    `Prijs: ${price}`,
    `📊 Kwaliteit ${conf} • BTC ${btcState || "-"}`,
    `📈 1u ${ch1h} • 24u ${ch24}`,
  ];

  if (tp != null || sl != null || rr != null) {
    lines.push(formatTpSl(tradePlan));
  }

  if (spread !== "-" || depth !== "-" || obScore !== "-") {
    lines.push(`🌊 Spread ${spread} • Depth ${depth} • OB ${obScore}`);
  }

  if (reason) {
    lines.push(`📝 ${cleanReason(reason)}`);
  }

  return lines.filter(Boolean).join("\n");
}