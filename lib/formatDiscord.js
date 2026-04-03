// lib/formatDiscord.js
// Cleaner message formatting + color helper

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
  if (s === "main") return "Cashflow";
  if (s === "moon") return "Runner";
  return s || "Signal";
}
function modeLabel(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === "bull") return "LONG";
  if (m === "bear") return "SHORT";
  return upper(mode);
}
function stageLabel(stage) {
  return String(stage || "UNKNOWN").replaceAll("_", " ").toUpperCase();
}
function isEliteStage(stage) {
  const s = upper(stage);
  return s === "ELITE_IGNITION" || s === "ELITE_EXPANSION" || s === "ELITE_CASCADE";
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
  return String(mode || "").toLowerCase() === "bear" ? "short" : "long";
}

function cleanReason(reason) {
  if (!reason) return "-";
  const r = String(reason).toLowerCase();

  const map = {
    take_profit: "Take profit geraakt.",
    stop_loss: "Stop loss geraakt.",
    btc_hard_against: "BTC draaide hard tegen de positie.",
    regime_panic: "Marktregime werd te riskant.",
    depth_failed: "Orderboek-depth viel weg.",
    spread_explosion: "Spread liep te ver op.",
    trade_candidate_lost: "Coin verloor trade-candidate status.",
    stage_lost: "Elite-structuur viel weg.",
    quality_collapse: "Entry quality zakte te ver weg.",
    persistence_collapse: "Persistence verloor te veel kracht.",
    timeout_no_followthrough: "Geen follow-through na de entry.",
    thesis_damage_confirmed: "Setup verloor op meerdere punten overtuiging.",
    grace_hold: "Trade zit nog in grace hold.",
    hold_valid: "Positie blijft valide.",
    weak_hold: "Tijdelijke zwakte zonder bevestigde break.",
    entry_confirmed: "Scanner-setup bevestigd.",
    entry_early_strength: "Vroege entry op sterke scanner-setup.",
    watch_timing: "Timing nog net niet optimaal.",
  };

  return map[r] || String(reason);
}

export function getDiscordColor({ kind, pnl, reason }) {
  const k = String(kind || "").toLowerCase();
  const p = Number(pnl);
  const r = String(reason || "").toLowerCase();

  if (k === "trade_opened") return 3447003; // blauw

  if (k === "position_update") {
    if (Number.isFinite(p) && p < 0) return 15105570; // oranje
    return 5763719; // groen
  }

  if (k === "trade_closed") {
    if (r === "take_profit") return 5763719; // groen
    if (r === "stop_loss") return 15548997; // rood
    if (Number.isFinite(p) && p >= 0) return 5763719;
    return 15105570; // amber
  }

  // default signal/watch
  return 3066993;
}

function shouldShowPlanAlways({ kind, stage, coin }) {
  const k = String(kind || "").toLowerCase();
  const s = upper(stage || coin?.stage || "");
  if (k === "trade_opened" || k === "trade_closed") return true;
  if (isEliteStage(s)) return true;
  return false;
}

export function formatSignalMessage({ source, stage, mode, coin, btcState, kind, pnl, reason }) {
  const symbol = coin?.symbol || "?";
  const price = fmtNum(coin?.price);
  const conf = coin?.entryQuality ?? coin?.confidence ?? "-";
  const persistence = coin?.persistenceScore != null ? fmtNum(coin.persistenceScore, 1) : "-";
  const breakoutPressure = coin?.breakout?.pressure != null ? fmtNum(coin.breakout.pressure, 1) : "-";
  const ch1h = coin?.change1h != null ? fmtPct(coin.change1h, 2) : "-";
  const ch24 = coin?.change24 != null ? fmtPct(coin.change24, 2) : "-";
  const spread = coin?.ob?.spreadPct != null ? `${fmtNum(coin.ob.spreadPct, 3)}%` : "-";
  const depth = coin?.ob?.depthMinUsd1p != null ? fmtUsd(coin.ob.depthMinUsd1p, 0) : "-";
  const obScore = coin?.ob?.score != null ? fmtNum(coin.ob.score, 5) : "-";

  const entry = getEntryValue(coin);
  const tp = getTpValue(coin);
  const sl = getSlValue(coin);
  const rr = getRrValue(coin);

  const tradePlan = { entry, tp, sl, rr };

  const header = `**${sourceLabel(source)} • ${modeLabel(mode)} • ${stageLabel(stage)}**`;

  const showPlan = shouldShowPlanAlways({ kind, stage, coin });
  const planLine = showPlan
    ? formatTpSl(tradePlan)
    : (tp != null || sl != null || rr != null ? formatTpSl(tradePlan) : "");

  if (kind === "trade_opened") {
    const engineHint =
      String(source || "").toLowerCase() === "main"
        ? "Doel: snelle winst veiligstellen (Cashflow)."
        : String(source || "").toLowerCase() === "moon"
          ? "Doel: laten lopen voor grote winst (Runner)."
          : "";

    return [
      header,
      "",
      `🟢 **TRADE OPENED — ${symbol}**`,
      `Scanner gaf de voorzet; deze **${getDirectionText(mode)} trade** is nu geactiveerd rond **${price}**.`,
      engineHint ? `🧠 ${engineHint}` : "",
      "",
      `📍 Entry ${entry != null ? fmtNum(entry) : price}`,
      planLine || "🎯 TP - • 🛡️ SL - • ⚖️ RR -",
      `📊 Quality ${conf} • Persistence ${persistence} • Breakout ${breakoutPressure}`,
      `🌊 Spread ${spread} • Depth ${depth} • OB ${obScore}`,
      `₿ BTC ${btcState || "-"} • 1u ${ch1h} • 24u ${ch24}`,
      reason ? `📝 Thesis: ${cleanReason(reason)}` : "",
    ].filter(Boolean).join("\n");
  }

  if (kind === "trade_closed") {
    const entryText = entry != null ? fmtNum(entry) : "-";
    const exitText = coin?.price != null ? fmtNum(coin.price) : "-";
    const pnlText = pnl != null ? fmtPct(pnl, 2) : "-";

    return [
      header,
      "",
      `🔴 **TRADE CLOSED — ${symbol}**`,
      `**Exit reason:** ${cleanReason(reason)}`,
      "",
      `📍 Entry ${entryText}`,
      `🏁 Exit ${exitText}`,
      planLine || "🎯 TP - • 🛡️ SL - • ⚖️ RR -",
      `📊 Resultaat ${pnlText}`,
      `₿ BTC ${btcState || "-"} • 1u ${ch1h} • 24u ${ch24}`,
    ].filter(Boolean).join("\n");
  }

  // default signal/watch
  return [
    header,
    "",
    `👀 **${symbol} staat op de radar**`,
    `Prijs: **${price}**`,
    `📊 Quality ${conf} • Persistence ${persistence} • Breakout ${breakoutPressure}`,
    `₿ BTC ${btcState || "-"} • 1u ${ch1h} • 24u ${ch24}`,
    planLine,
    (spread !== "-" || depth !== "-" || obScore !== "-") ? `🌊 Spread ${spread} • Depth ${depth} • OB ${obScore}` : "",
    reason ? `📝 ${cleanReason(reason)}` : "",
  ].filter(Boolean).join("\n");
}