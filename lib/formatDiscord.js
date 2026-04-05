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
  "Een technisch hoogwaardige setup waarbij de marktstructuur volledig in ons voordeel werkt.",
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
  "Echt een kans voor de actieve trader. De grafiek vertoont sterke koopdruk in de korte termijn.",
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

function up(x) {
  return String(x || "").toUpperCase();
}

// ✅ Alleen voor MOON: pak tradePlan (of fallback execution.meta.tradePlan)
function getMoonPlan(coin) {
  return coin?.tradePlan || coin?.execution?.meta?.tradePlan || null;
}

export function getDiscordColor({ kind, pnl }) {
  const k = String(kind || "signal").toLowerCase();
  if (k === "trade_opened") return 3447003; // Blauw
  if (k === "trade_closed") return Number(pnl) >= 0 ? 5763719 : 15548997; // Groen : Rood
  return 3066993;
}

export function formatSignalMessage({ source, stage, kind, coin, pnl }) {
  const symbol = up(coin?.symbol);
  const isMoon = String(source || "").toLowerCase() === "moon";
  const typeLabel = isMoon ? "[ALPHA]" : "[CORE]";

  // Nieuwe benamingen logica
  let niveau = "MARKET PULSE";
  const st = up(stage);
  const k = String(kind || "signal").toLowerCase();

  // ✅ FIX: Moon elite stages moeten APEX zijn, ook als kind="signal"
  if (k.includes("elite") || k.includes("trade_") || st.startsWith("ELITE_")) {
    niveau = "APEX PRIORITY";
  } else if (k === "alert" || st === "ENTRY" || st === "ALMOST") {
    niveau = "PRIME SETUP";
  }

  // Kies willekeurige beschrijving
  const descList = isMoon ? alphaDescriptions : coreDescriptions;
  const randomDesc = descList[Math.floor(Math.random() * descList.length)];

  const header = `## ${niveau} | ${typeLabel}`;

  // ✅ TRADE CLOSED
  if (k === "trade_closed") {
    return [
      header,
      `🔴 **TRADE CLOSED — ${symbol}**`,
      `Sluitprijs: **${fmtNum(coin?.price)}**`,
      `📊 Resultaat: **${fmtPct(pnl)}**`,
    ].join("\n");
  }

  // Title line
  const titleLine =
    k === "trade_opened"
      ? `🟢 **TRADE OPENED — ${symbol}**`
      : `**Munt: $${symbol}**`;

  // -----------------------------
  // ✅ ENTRY / TP / SL regels
  // MAIN blijft exact zoals jij had (coin.entry/tp/sl)
  // MOON gebruikt tradePlan fallback
  // -----------------------------
  let entryVal = coin?.entry || coin?.price;
  let tpVal = coin?.tp || "-";
  let slVal = coin?.sl || "-";

  if (isMoon) {
    const plan = getMoonPlan(coin);
    if (plan) {
      entryVal = plan.entry ?? coin?.price;
      tpVal = plan.tp ?? "-";
      slVal = plan.sl ?? "-";
    } else {
      // fallback (als plan ontbreekt)
      entryVal = coin?.price;
      tpVal = "-";
      slVal = "-";
    }
  }

  return [
    header,
    titleLine,
    "",
    `*${randomDesc}*`,
    "",
    "---",
    `📥 **Entry:** ${fmtNum(entryVal)}`,
    `🎯 **Take Profit:** ${fmtNum(tpVal)}`,
    `❌ **Stop Loss:** ${fmtNum(slVal)}`,
  ].join("\n");
}