function line(c) {
  const ch = (c.change24 ?? 0).toFixed?.(2) ?? c.change24;
  const vm = (c.vm ?? 0).toFixed?.(2) ?? c.vm;
  const ob = (c.obScore ?? null) === null ? "-" : (c.obScore).toFixed?.(3) ?? c.obScore;
  const edge = c.edgeScore ?? "-";
  const sl = c.sl ? `${c.sl}` : "-";
  const tp = c.tp ? `${c.tp}` : "-";
  return `• **${c.symbol}** | 24h: **${ch}%** | VM: ${vm} | OB: ${ob} | Edge: ${edge} | SL: ${sl} | TP: ${tp}`;
}

export function formatStage(stageName, bullCoins, bearCoins) {
  const b = (bullCoins || []).slice(0, 12);
  const s = (bearCoins || []).slice(0, 12);

  if (b.length === 0 && s.length === 0) return null;

  let out = `**${stageName}**\n`;

  if (b.length) out += `\n🟢 **BULL**\n${b.map(line).join("\n")}\n`;
  if (s.length) out += `\n🔴 **BEAR**\n${s.map(line).join("\n")}\n`;

  return out.trim();
}