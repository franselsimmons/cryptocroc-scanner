// lib/formatDiscord.js

const coreDescriptions = [
  "Deze munt bouwt een sterke bodem op de hogere timeframes. Een technisch zeer solide instapmoment.",
  "We zien een succesvolle retest van de support-zone. De weg naar boven ligt nu open.",
  "Prachtige prijsactie met afnemend verkoopvolume. Dit wijst op accumulatie door grote partijen.",
  "De trendkracht neemt gestaag toe. Een geduldige aanpak wordt hier waarschijnlijk beloond.",
  "Klassieke 'bullish' structuur. Alle indicatoren staan op groen voor een gezonde stijging.",
  "De consolidatiefase lijkt bijna voorbij. We verwachten een stabiele uitbraak vanuit deze zone.",
  "Mooie risk-to-reward ratio op dit niveau. De grafiek oogt erg 'clean' en betrouwbaar.",
  "Prijs houdt zich sterk vast aan de trendlijn. Een veilige play voor de middellange termijn.",
  "Volume bevestigt de huidige trend. We zien weinig weerstand tot aan het eerste doel.",
  "Een technisch hoogwaardige setup waarbij de marktstructuur volledig in ons voordeel werkt."
];

const alphaDescriptions = [
  "Er komt plotseling veel momentum in deze munt. Ideaal voor een snelle trade op de uitbraak.",
  "Agressieve inkooporders gespot op de lagere timeframes. Dit kan heel snel gaan bewegen.",
  "De volatiliteit neemt toe, wat duidt op een aanstaande explosieve move. Houd de SL scherp.",
  "Momentum-play pur sang. We liften hier mee op de sterke stijgende trend van de afgelopen uren.",
  "Prijsactie is momenteel erg impulsief. Een uitstekende kans voor wie kort op de bal speelt.",
  "Hoge on-chain activiteit gesignaleerd. Deze munt trekt momenteel veel speculatief kapitaal aan.",
  "Klassieke 'break-and-retest' op hoog volume. We verwachten een snelle vervolgbeweging.",
  "De markt reageert heftig op dit niveau. Een agressieve setup met een hoge potentiële winst.",
  "Trend-versnelling in volle gang. Pak je winst op de aangegeven targets en wees scherp.",
  "Echt een kans voor de actieve trader. De grafiek vertoont sterke koopdruk in de korte termijn."
];

const fmtNum = (x) => {
  const v = Number(x);
  return Number.isFinite(v) ? v.toFixed(4).replace(/\.?0+$/, "") : "-";
};

const fmtPct = (x) => {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return (v > 0 ? "+" : "") + v.toFixed(2) + "%";
};

function up(x) { return String(x || "").toUpperCase(); }

export function getDiscordColor({ kind, pnl }) {
  const k = String(kind || "signal").toLowerCase();
  if (k === "trade_opened") return 3447003; // Blauw
  if (k === "trade_closed") return (Number(pnl) >= 0) ? 5763719 : 15548997; // Groen : Rood
  return 3066993; // Default
}

export function formatSignalMessage({ source, stage, kind, coin, pnl }) {
  const symbol = up(coin?.symbol);
  const isMoon = String(source).toLowerCase() === "moon";
  const typeLabel = isMoon ? "[ALPHA]" : "[CORE]";
  
  // Mapping niveaus
  let niveau = "MARKET PULSE"; 
  const st = up(stage);
  const k = String(kind).toLowerCase();

  if (k.includes("elite") || k.includes("trade_")) niveau = "APEX PRIORITY";
  else if (k === "alert" || st === "ENTRY" || st === "ALMOST") niveau = "PRIME SETUP";

  // Kies willekeurige beschrijving
  const descList = isMoon ? alphaDescriptions : coreDescriptions;
  const randomDesc = descList[Math.floor(Math.random() * descList.length)];

  // Header constructie: ## NIVEAU | TYPE
  const header = `## ${niveau} | ${typeLabel}`;

  if (k === "trade_closed") {
    return [
      header,
      `🔴 **TRADE CLOSED — ${symbol}**`,
      `Sluitprijs: **${fmtNum(coin?.price)}**`,
      `📊 Resultaat: **${fmtPct(pnl)}**`
    ].join("\n");
  }

  const titleLine = k === "trade_opened" ? `🟢 **TRADE OPENED — ${symbol}**` : `**Munt: $${symbol}**`;

  const rows = [
    header,
    titleLine,
    "",
    `*${randomDesc}*`,
    "",
    "---",
    `📥 **Entry:** ${fmtNum(coin?.entry || coin?.price)}`,
    `🎯 **Take Profit:** ${fmtNum(coin?.tp || "-")}`,
    `❌ **Stop Loss:** ${fmtNum(coin?.sl || "-")}`
  ];

  return rows.join("\n");
}
