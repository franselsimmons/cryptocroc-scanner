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

  const sl =
    c?.tradePlan?.sl ??
    c?.sl ??
    null;

  const tp =
    c?.tradePlan?.tp ??
    c?.tp ??
    null;

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

  const moveProb =
    String(mode).toLowerCase() === "bear"
      ? coin?.dumpProbability
      : coin?.moonProbability;

  const titleEmoji = String(mode).toLowerCase() === "bear" ? "🔻" : "🚀";
  const sourceLabel = String(source || "").toLowerCase() === "moon" ? "MOON" : "MAIN";

  return [
    `${titleEmoji} **${sourceLabel} ${String(stage || "").toUpperCase()} • ${String(mode || "").toUpperCase()}**`,
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
    `Move prob: **${
      Number.isFinite(Number(moveProb)) ? `${(Number(moveProb) * 100).toFixed(1)}%` : "-"
    }**`,
  ].join("\n");
}