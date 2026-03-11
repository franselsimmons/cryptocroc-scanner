// lib/formatDiscord.js

function num(x, d = 2) {
  const n = Number(x);
  return Number.isFinite(n) ? n.toFixed(d) : "-";
}

function pct(x, d = 2) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
}

function price(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "-";
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.01) return n.toFixed(6);
  return n.toFixed(8);
}

function stageLabel(stage, source = "main") {
  const s = String(stage || "").toUpperCase();
  const src = String(source || "").toLowerCase();

  if (src === "moon") {
    if (s === "ELITE_IGNITION") return "MOON ELITE IGNITION";
    if (s === "ELITE_EXPANSION") return "MOON ELITE EXPANSION";
    if (s === "ELITE_CASCADE") return "MOON ELITE CASCADE";
    if (s === "ALMOST") return "MOON ALMOST";
    if (s === "BUILDUP") return "MOON BUILDUP";
    if (s === "RADAR") return "MOON RADAR";
    if (s === "HOLD") return "MOON HOLD";
    if (s === "SELL") return "MOON SELL";
  }

  if (s === "ENTRY") return "ENTRY";
  if (s === "ALMOST") return "ALMOST";
  if (s === "BUILDUP") return "BUILDUP";
  if (s === "RADAR") return "RADAR";
  if (s === "HOLD") return "HOLD";
  if (s === "SELL") return "SELL";
  return s || "-";
}

function actionLabel(stage, source = "main") {
  const s = String(stage || "").toUpperCase();
  const src = String(source || "").toLowerCase();

  if (s === "ENTRY") return "Instap mogelijk";
  if (s === "HOLD") return "Vasthouden";
  if (s === "SELL") return "Sluiten";
  if (s === "ALMOST") return "Klaarzetten";
  if (s === "BUILDUP") return "Watchlist";
  if (s === "RADAR") return "Alleen volgen";

  if (src === "moon") {
    if (s === "ELITE_IGNITION") return "Focus / agressieve watch";
    if (s === "ELITE_EXPANSION") return "Momentum loopt hard";
    if (s === "ELITE_CASCADE") return "Sterke neerwaartse move";
  }

  return "Volgen";
}

function statusLabel(stage, source = "main") {
  const s = String(stage || "").toUpperCase();
  const src = String(source || "").toLowerCase();

  if (s === "ENTRY") return "Nieuw signaal";
  if (s === "HOLD") return "Positie nog geldig";
  if (s === "SELL") return "Positie sluiten";
  if (s === "ALMOST") return "Bijna klaar";
  if (s === "BUILDUP") return "In opbouw";
  if (s === "RADAR") return "Vroege setup";

  if (src === "moon") {
    if (s === "ELITE_IGNITION") return "Vlak voor grote move";
    if (s === "ELITE_EXPANSION") return "Move is bezig";
    if (s === "ELITE_CASCADE") return "Sterke daling actief";
  }

  return "Actief";
}

function buildWhatToDo(stage, source = "main", mode = "bull") {
  const s = String(stage || "").toUpperCase();
  const src = String(source || "").toLowerCase();
  const isBear = String(mode || "").toLowerCase() === "bear";

  if (s === "SELL") {
    return [
      "• Trade is klaar",
      "• Niet direct re-enteren zonder nieuw signaal",
      "• Wacht op een nieuwe setup",
    ].join("\n");
  }

  if (s === "HOLD") {
    return [
      "• Positie laten lopen zolang SL niet geraakt is",
      "• Niet onnodig in- en uitstappen",
      "• Alleen managen, niet forceren",
    ].join("\n");
  }

  if (s === "ENTRY") {
    return [
      `• ${isBear ? "Short-entry mogelijk volgens je plan" : "Entry mogelijk volgens je plan"}`,
      "• Gebruik SL strikt",
      "• Niet najagen als prijs al te ver van entry ligt",
    ].join("\n");
  }

  if (s === "ALMOST") {
    return [
      "• Klaarzetten op je watchlist",
      "• Wachten op extra bevestiging",
      "• Nog niet blind instappen",
    ].join("\n");
  }

  if (s === "BUILDUP") {
    return [
      "• Alleen watchlist",
      "• Momentum bouwt op maar setup is nog niet af",
      "• Wachten op upgrade richting ALMOST of ENTRY",
    ].join("\n");
  }

  if (s === "RADAR") {
    return [
      "• Alleen volgen",
      "• Nog te vroeg voor actie",
      "• Interessant als de setup verder opbouwt",
    ].join("\n");
  }

  if (src === "moon" && s === "ELITE_IGNITION") {
    return [
      "• Focus op deze coin",
      "• Alleen bedoeld voor snelle high-momentum setups",
      "• Niet laat instappen na een verticale candle",
    ].join("\n");
  }

  if (src === "moon" && s === "ELITE_EXPANSION") {
    return [
      "• Move loopt al hard",
      "• Alleen instappen als jouw plan dit toestaat",
      "• Wees extra scherp op risk management",
    ].join("\n");
  }

  if (src === "moon" && s === "ELITE_CASCADE") {
    return [
      "• Sterke neerwaartse move actief",
      "• Alleen voor snelle bearish momentum setups",
      "• Niet forceren als de move al te ver is gelopen",
    ].join("\n");
  }

  return [
    "• Volgen volgens je plan",
    "• Gebruik risk management",
    "• Wacht op bevestiging",
  ].join("\n");
}

function compactLine(c) {
  const symbol = c?.symbol || "-";
  const ch24 = pct(c?.change24, 2);
  const vm = num(c?.vm, 2);
  const ob =
    Number.isFinite(Number(c?.ob?.score))
      ? num(c.ob.score, 3)
      : Number.isFinite(Number(c?.obScore))
      ? num(c.obScore, 3)
      : "-";
  const edge =
    Number.isFinite(Number(c?.confidence))
      ? Math.round(Number(c.confidence))
      : Number.isFinite(Number(c?.edgeScore))
      ? Math.round(Number(c.edgeScore))
      : "-";

  const sl = c?.tradePlan?.sl ?? c?.sl ?? null;
  const tp = c?.tradePlan?.tp ?? c?.tp ?? null;

  return [
    `• **${symbol}**`,
    `24h: **${ch24}**`,
    `VM: ${vm}`,
    `OB: ${ob}`,
    `Conf: ${edge}`,
    `SL: ${sl != null ? price(sl) : "-"}`,
    `TP: ${tp != null ? price(tp) : "-"}`,
  ].join(" | ");
}

/**
 * OUDE export voor cron.js
 * Houdt legacy code werkend.
 */
export function formatStage(stageName, bullCoins, bearCoins) {
  const b = Array.isArray(bullCoins) ? bullCoins.slice(0, 12) : [];
  const s = Array.isArray(bearCoins) ? bearCoins.slice(0, 12) : [];

  if (b.length === 0 && s.length === 0) return null;

  let out = `**${stageName}**\n`;

  if (b.length) {
    out += `\n🟢 **BULL**\n${b.map(compactLine).join("\n")}\n`;
  }

  if (s.length) {
    out += `\n🔴 **BEAR**\n${s.map(compactLine).join("\n")}\n`;
  }

  return out.trim();
}

/**
 * NIEUWE export voor single-signal berichten
 */
export function formatSignalMessage({ source, stage, mode, coin, btcState }) {
  const symbol = coin?.symbol || "-";
  const name = coin?.name || "";
  const entry = coin?.tradePlan?.entry ?? coin?.price ?? null;
  const sl = coin?.tradePlan?.sl ?? coin?.sl ?? null;
  const tp = coin?.tradePlan?.tp ?? coin?.tp ?? null;
  const rr = coin?.tradePlan?.rr ?? coin?.rr ?? null;

  const confRaw = coin?.confidence ?? coin?.edgeScore;
  const conf =
    Number.isFinite(Number(confRaw)) ? Math.round(Number(confRaw)) : "-";

  const moveProb =
    String(mode).toLowerCase() === "bear"
      ? coin?.dumpProbability
      : coin?.moonProbability;

  const moveProbText = Number.isFinite(Number(moveProb))
    ? `${(Number(moveProb) * 100).toFixed(1)}%`
    : "-";

  const isBear = String(mode).toLowerCase() === "bear";
  const emoji =
    String(stage || "").toUpperCase() === "SELL"
      ? "🔴"
      : String(stage || "").toUpperCase() === "HOLD"
      ? "🟢"
      : isBear
      ? "🔻"
      : "🚀";

  const stageText = stageLabel(stage, source);
  const actionText = actionLabel(stage, source);
  const statusText = statusLabel(stage, source);
  const todoText = buildWhatToDo(stage, source, mode);

  return [
    `${emoji} **${stageText} • ${String(mode || "").toUpperCase()}**`,
    ``,
    `**Coin:** ${symbol}${name ? ` (${name})` : ""}`,
    `**Actie:** ${actionText}`,
    `**Status:** ${statusText}`,
    ``,
    `**Entry:** ${price(entry)}`,
    `**Take Profit:** ${price(tp)}`,
    `**Stop Loss:** ${price(sl)}`,
    `**Risk/Reward:** ${num(rr, 2)}`,
    ``,
    `**24h:** ${pct(coin?.change24)}`,
    `**1h:** ${pct(coin?.change1h)}`,
    `**VM:** ${num(coin?.vm, 2)}`,
    `**Confidence:** ${conf}/100`,
    `**OB:** ${num(coin?.ob?.score ?? coin?.obScore, 3)}`,
    `**BTC:** ${btcState || "-"}`,
    String(source || "").toLowerCase() === "moon"
      ? `**Move probability:** ${moveProbText}`
      : null,
    ``,
    `**Wat te doen:**`,
    todoText,
  ]
    .filter(Boolean)
    .join("\n");
}