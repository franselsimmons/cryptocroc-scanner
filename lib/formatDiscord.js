// lib/formatDiscord.js
const apexDescriptions = [ /* ... same as before ... */ ];
const primeDescriptions = [ /* ... same ... */ ];
const pulseDescriptions = [ /* ... same ... */ ];

const fmtNum = (x) => { const v = Number(x); return Number.isFinite(v) ? v.toFixed(4).replace(/\.?0+$/, "") : "-"; };
const fmtPct = (x) => { const v = Number(x); if (!Number.isFinite(v)) return "-"; return (v > 0 ? "+" : "") + v.toFixed(2) + "%"; };
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

  // APEX prioriteit voor elite stages, trade events, of upgrades die elite stage bereiken
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