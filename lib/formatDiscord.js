// lib/formatDiscord.js
// Helper functies voor het formatteren van getallen
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

/**
 * Genereert een Discord-bericht voor één signaal (coin).
 * @param {Object} params
 * @param {string} params.source - "MAIN" of "MOON"
 * @param {string} params.stage - bijv. "RADAR", "BUILDUP", "ALMOST", "ENTRY", "ELITE", "IGNITION", "EXPANSION", "CASCADE"
 * @param {string} params.mode - "bull" of "bear"
 * @param {Object} params.coin - het coin-object (met o.a. symbol, name, tradePlan, change24, change1h, vm, confidence, ob, moonProbability, dumpProbability)
 * @param {string} params.btcState - "BULL", "BEAR", "NEUTRAL"
 * @returns {string} geformatteerd bericht
 */
export function formatSignalMessage({ source, stage, mode, coin, btcState }) {
  const symbol = coin?.symbol || "-";
  const name = coin?.name || "";
  const entry = coin?.tradePlan?.entry ?? coin?.price ?? null;
  const sl = coin?.tradePlan?.sl ?? coin?.sl ?? null;
  const tp = coin?.tradePlan?.tp ?? coin?.tp ?? null;
  const rr = coin?.tradePlan?.rr ?? coin?.rr ?? null;

  const moveProb = mode === "bear" ? coin?.dumpProbability : coin?.moonProbability;

  const titleEmoji = mode === "bear" ? "🔻" : "🚀";
  const sourceLabel = source === "moon" ? "MOON" : "MAIN";

  return [
    `${titleEmoji} **${sourceLabel} ${stage} • ${mode.toUpperCase()}**`,
    ``,
    `**${symbol}** ${name ? `(${name})` : ""}`,
    `Entry: **${price(entry)}**`,
    `SL: **${price(sl)}**`,
    `TP: **${price(tp)}**`,
    `R:R: **${num(rr, 2)}**`,
    ``,
    `24h: **${pct(coin?.change24)}**`,
    `1h: **${pct(coin?.change1h)}**`,
    `VM: **${num(coin?.vm, 2)}**`,
    `Confidence: **${num(coin?.confidence ?? coin?.edgeScore, 0)}/100**`,
    `OB: **${num(coin?.ob?.score ?? coin?.obScore, 3)}**`,
    `BTC: **${btcState || "-"}**`,
    `Move prob: **${Number.isFinite(Number(moveProb)) ? `${(Number(moveProb) * 100).toFixed(1)}%` : "-"}`,
  ].join("\n");
}