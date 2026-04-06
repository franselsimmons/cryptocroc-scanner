// lib/formatDiscord.js

const apexDescriptions = [
  "Institutionele accumulatie gedetecteerd op de hoge timeframes. Dit is een setup met zeer hoge convictie.",
  "De marktstructuur op de daggrafiek is volledig bullish gekeerd. We verwachten een significante trend-move.",
  "Whale-activiteit bevestigt deze zone als sterke bodem. Een uitgelezen kans voor de geduldige trader.",
  "Meerdere algoritmes convergeren op dit prijsniveau. Dit duidt op een zeer sterke technische setup.",
  "Grote kooporders stromen binnen in de orderflow. De weg naar boven is vrij van grote weerstand.",
  "Klassiek reversal-patroon bevestigd met zwaar volume. Dit signaal heeft de hoogste prioriteit.",
  "De risk-to-reward ratio op dit niveau is uitzonderlijk goed voor een grotere positie.",
  "Trend-bevestiging op zowel de 4u als 1d grafiek. Een technisch meesterwerk in de maak.",
  "Prijsactie suggereert dat de bodem definitief gezet is. We kijken naar een langdurige stijging.",
  "Dit niveau wordt agressief verdedigd door kopers. Een uitbraak lijkt onvermijdelijk.",
  "On-chain data laat zien dat munten van exchanges naar wallets gaan. Supply shock in aantocht.",
  "Een zeldzame samenloop van indicatoren wijst op een krachtige trendomslag.",
  "De consolidatie van de afgelopen weken lijkt hier te worden doorbroken met overtuiging.",
  "Volume-profiel laat zien dat er boven dit niveau nauwelijks weerstand is tot aan de targets.",
  "Bullish divergentie op de wekelijkse grafiek. Dit is een setup voor de lange adem.",
  "De macro-trend ondersteunt deze move volledig. Een veilige haven in de huidige markt.",
  "Krachtige prijsactie boven de belangrijkste moving averages. De trend is je vriend.",
  "Orderbook-analyse laat een enorme muur van biedingen zien direct onder de huidige prijs.",
  "Dit signaal voldoet aan al onze strengste filter-eisen. Apex kwaliteit.",
  "De volatiliteit neemt af terwijl de prijs stijgt; een teken van een zeer gezonde trend."
];

const primeDescriptions = [
  "Een solide breakout-retest setup. De prijs heeft de oude weerstand nu als support bevestigd.",
  "Technisch een erg 'clean' patroon. We liften mee op het gezonde momentum van deze munt.",
  "De RSI laat ruimte voor een mooie move omhoog zonder direct overbought te raken.",
  "Prijsactie respecteert de stijgende trendlijn perfect. Een betrouwbaar instapmoment.",
  "Mooie balans tussen risico en potentieel rendement. De grafiek oogt stabiel en veelbelovend.",
  "We zien een toename in handelsvolume bij elke kleine dip. De markt wil duidelijk hoger.",
  "Een klassiek vlag-patroon vormt zich op de 4-uurs grafiek. Uitbraak lijkt aanstaande.",
  "De munt herstelt sneller dan de rest van de markt. Sterke relatieve kracht gesignaleerd.",
  "Moving averages kruisen bullish (Golden Cross potentie). De trend versnelt.",
  "Support op dit niveau is al drie keer getest en houdt stand. Een veilige basis voor een trade.",
  "De verkoopdruk neemt af terwijl we hogere bodems maken. De kopers nemen het stokje over.",
  "Prima setup voor een swing-trade. De technische indicatoren staan netjes op één lijn.",
  "Breakout boven de 200 EMA. Dit is vaak het startpunt voor een grotere stijging.",
  "Gezonde consolidatie na een eerdere rally. De markt is klaar voor de volgende leg up.",
  "Goede liquiditeit en duidelijke prijsactie maken dit een zeer handelbare setup.",
  "Bollinger Bands knijpen samen; we verwachten een impulsieve beweging in de richting van de trend.",
  "Horizontale weerstand is eindelijk gebroken. We kijken nu uit naar de volgende targets.",
  "Accumulatie-fase lijkt afgerond. Het momentum begint nu echt op te bouwen.",
  "Mooie technische structuur met duidelijke invalidatie-punten. Risico is goed beheersbaar.",
  "Prijs houdt vast boven de wekelijkse pivot. Dit geeft vertrouwen voor de komende dagen."
];

const pulseDescriptions = [
  "Plotselinge piek in volume gedetecteerd. We houden dit momentum nauwlettend in de gaten.",
  "Kortstondige kans op een snelle scalp. De prijs reageert heftig op deze korte-termijn support.",
  "Agressieve prijsactie op de lagere timeframes. Ideaal voor de actieve trader.",
  "Kans op een snelle uitbraak. Let op de volatiliteit in deze zone.",
  "Momentum bouwt zich razendsnel op. Wees scherp op de entry voor een snelle move.",
  "RSI-divergentie gespot op de 15-minuten grafiek. Mogelijk een snelle bounce in aantocht.",
  "De munt trekt momenteel veel speculatief kapitaal aan. Snelle winsten zijn mogelijk.",
  "Korte consolidatie na een heftige beweging. We verwachten een snelle vervolgbeweging.",
  "Prijsactie is impulsief. Gebruik strikte stops bij deze korte-termijn setup.",
  "Volume-spikes wijzen op een mogelijke trendbreuk. Een interessante move om te volgen.",
  "Kans op een 'short squeeze' als de prijs boven dit niveau blijft houden.",
  "De munt vertoont 'high-speed' momentum. Alleen voor wie kort op de bal speelt.",
  "Technisch herstel vanaf de oversold-zone. Een snelle reactie omhoog is waarschijnlijk.",
  "Mooie kans op een dag-trade. De volatiliteit biedt genoeg ruimte voor winst.",
  "De munt reageert op nieuws of social volume. Momentum-play in volle gang.",
  "Snelle retest van de breakout-zone. We kijken of de kopers direct weer instappen.",
  "Korte termijn trend is krachtig omhoog gedraaid. We volgen de flow.",
  "Prijsactie is wat volatieler, maar de richting is duidelijk. Focus op momentum.",
  "Scanner detecteert ongebruikelijke koopdruk op de lagere timeframes.",
  "Momentum-indicator slaat groen uit. We verwachten een snelle test van de eerste targets."
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
  if (k === "trade_opened") return 3447003; 
  if (k === "trade_closed") return (Number(pnl) >= 0) ? 5763719 : 15548997;
  return 3066993; 
}

export function formatSignalMessage({ source, stage, kind, coin, pnl }) {
  const symbol = up(coin?.symbol);
  const side = up(coin?.side) === "SHORT" ? "🔴 SHORT" : "🟢 LONG";
  const isMoon = String(source).toLowerCase() === "moon";
  const typeLabel = isMoon ? "[ALPHA]" : "[CORE]";
  const st = up(stage);
  const k = String(kind).toLowerCase();

  let niveau = "MARKET PULSE";
  let descList = pulseDescriptions;

  // APEX priority for elite stages, trade events, or upgrades that reach elite stage
  if (
    k.includes("elite") ||
    k.includes("trade_") ||
    st === "ELITE_IGNITION" ||
    st === "ELITE_EXPANSION" ||
    st === "ELITE_CASCADE"
  ) {
    niveau = "APEX PRIORITY";
    descList = apexDescriptions;
  } else if (k === "alert" || st === "ENTRY" || st === "ALMOST") {
    niveau = "PRIME SETUP";
    descList = primeDescriptions;
  }

  const header = `## ${niveau} | ${typeLabel}`;

  if (k === "trade_closed") {
    return [
      header,
      `🏁 **TRADE CLOSED — ${symbol}**`,
      `Type: **${side}**`,
      `Sluitprijs: **${fmtNum(coin?.price)}**`,
      `📊 Resultaat: **${fmtPct(pnl)}**`
    ].join("\n");
  }

  const titleLine = k === "trade_opened" ? `🚀 **TRADE OPENED — ${symbol}**` : `**Setup: $${symbol}**`;
  const randomDesc = descList[Math.floor(Math.random() * descList.length)];

  // Use tradePlan if available for entry/tp/sl
  const plan = coin?.tradePlan || null;
  const entry = coin?.entry ?? plan?.entry ?? coin?.price;
  const tp = coin?.tp ?? plan?.tp ?? "-";
  const sl = coin?.sl ?? plan?.sl ?? "-";

  return [
    header,
    titleLine,
    `Type: **${side}**`,
    "",
    `*${randomDesc}*`,
    "",
    "---",
    `📥 **Enter:** ${fmtNum(entry)}`,
    `🎯 **TP:** ${fmtNum(tp)}`,
    `❌ **SL:** ${fmtNum(sl)}`
  ].join("\n");
}