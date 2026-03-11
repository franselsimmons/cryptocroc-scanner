import { kv } from "@vercel/kv";

const KEEP = 5000;
const EVENTS_KEY = (funnel) => `cc:events:${funnel}:list`;
const DEDUPE_TTL_SEC = 60 * 60 * 6; // 6 uur

// ======================================================
// Discord helper (behouden voor eventuele losse imports elders)
// ======================================================
export async function sendDiscord(webhook, title, description, color = 3066993) {
  if (!webhook) return;

  const chunks = [];
  const max = 3800;
  let s = String(description || "");

  while (s.length > max) {
    chunks.push(s.slice(0, max));
    s = s.slice(max);
  }
  chunks.push(s);

  for (let i = 0; i < chunks.length; i++) {
    const r = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        embeds: [
          {
            title: i === 0 ? title : `${title} (vervolg ${i + 1})`,
            description: chunks[i],
            color,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`Discord ${r.status}: ${txt.slice(0, 200)}`);
    }
  }
}

// ======================================================
// Formattering voor overzicht (wordt elders gebruikt)
// ======================================================
function line(c) {
  const ch = (c.change24 ?? 0).toFixed?.(2) ?? c.change24;
  const vm = (c.vm ?? 0).toFixed?.(2) ?? c.vm;
  const ob = (c.obScore ?? null) === null ? "-" : c.obScore.toFixed?.(3) ?? c.obScore;
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

// ======================================================
// Hulpfunctie voor getallen weergave
// ======================================================
function fmtNum(x, max = 8) {
  const v = Number(x);
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(max).replace(/\.?0+$/, "");
}

// ======================================================
// Deduplicatie keys
// ======================================================
function dedupeKey(funnel, item) {
  const f = String(funnel || "").toLowerCase();
  const symbol = String(item?.symbol || "?").toUpperCase();

  if (f === "scan_transition") {
    const from = String(item?.from || "").toUpperCase();
    const to = String(item?.to || "").toUpperCase();
    const reason = String(item?.reason || "").slice(0, 120);
    return `cc:dedupe:${f}:${symbol}:${from}->${to}:${reason}`;
  }

  if (f.startsWith("scan_")) {
    const stage = String(item?.stage || "").toUpperCase();
    const prevStage = String(item?.prevStage || "").toUpperCase();
    const reason = String(item?.reason || "").slice(0, 120);
    return `cc:dedupe:${f}:${symbol}:${prevStage}->${stage}:${reason}`;
  }

  const exitReason = String(item?.exitReason || item?.reason || "").slice(0, 120);
  return `cc:dedupe:${f}:${symbol}:${exitReason}`;
}

// ======================================================
// Discord formatter (behouden voor compatibiliteit / debug)
// Wordt NIET meer automatisch gepost vanuit pushEvent()
// ======================================================
function formatTpSl(t) {
  if (!t) return "";
  const tp = t.tp != null ? fmtNum(t.tp) : "-";
  const sl = t.sl != null ? fmtNum(t.sl) : "-";
  const rr = t.rr != null ? fmtNum(t.rr, 2) : "-";
  return `TP: ${tp} • SL: ${sl} • RR: ${rr}`;
}

export function formatDiscordMessage(funnel, item) {
  const t = item?.tradePlan || {};
  const mode = String(item?.mode || "").toUpperCase();
  const stage = String(item?.stage || "").toUpperCase();
  const prevStage = String(item?.prevStage || "").toUpperCase();
  const btcState = String(item?.btcState || "-").toUpperCase();

  const moveTxt =
    prevStage && prevStage !== stage
      ? `${prevStage} → ${stage}`
      : stage || "-";

  const symbol = item?.symbol || "?";
  const price = fmtNum(item?.price);
  const conf = item?.confidence ?? "-";
  const ch1h = `${fmtNum(item?.change1h, 3)}%`;
  const ch24 = `${fmtNum(item?.change24, 3)}%`;
  const spread = fmtNum(item?.ob?.spreadPct, 3);
  const depth = fmtNum(item?.ob?.depthMinUsd1p, 0);
  const obScore = fmtNum(item?.ob?.score, 5);
  const reason = item?.reason ? String(item.reason) : "";

  switch (String(funnel || "").toLowerCase()) {
    case "pump_alert":
      return [
        `🚀 **${symbol} • PUMP ALERT**`,
        `Prijs: ${price}`,
        `Pump probability: ${fmtNum(item?.probability, 3)}`,
      ].join("\n");

    case "dump_alert":
      return [
        `📉 **${symbol} • DUMP ALERT**`,
        `Prijs: ${price}`,
        `Dump probability: ${fmtNum(item?.probability, 3)}`,
      ].join("\n");

    case "scan_transition":
      return [
        `🔄 **${symbol} • ${mode}**`,
        `Van: ${item?.from || "-"} → Naar: ${item?.to || "-"}`,
        reason ? `Waarom: ${reason}` : null,
      ].filter(Boolean).join("\n");

    case "scan_entry":
      return [
        `🚨 **${symbol} • ${mode} • ${moveTxt}**`,
        `Prijs: ${price}`,
        formatTpSl(t),
        `Conf: ${conf} • BTC: ${btcState}`,
        `1h: ${ch1h} • 24h: ${ch24}`,
        `Spread: ${spread}% • Depth: ${depth} • OB: ${obScore}`,
      ].join("\n");

    case "scan_hold":
      return [
        `🟢 **${symbol} • ${mode} • ${moveTxt}**`,
        `Prijs: ${price}`,
        formatTpSl(t),
        `Conf: ${conf} • BTC: ${btcState}`,
        `Status: HOLD`,
      ].join("\n");

    case "scan_sell":
      return [
        `🔴 **${symbol} • ${mode} • ${moveTxt}**`,
        `Prijs: ${price}`,
        formatTpSl(t),
        `Status: SELL`,
      ].join("\n");

    case "trade_tp":
      return [
        `✅ **${symbol} • TAKE PROFIT**`,
        `Entry: ${fmtNum(item?.entryPrice)}`,
        `Exit: ${fmtNum(item?.exitPrice)}`,
        `PnL: ${fmtNum(item?.pnlPct, 2)}%`,
      ].join("\n");

    case "trade_sl":
      return [
        `⛔ **${symbol} • STOP LOSS**`,
        `Entry: ${fmtNum(item?.entryPrice)}`,
        `Exit: ${fmtNum(item?.exitPrice)}`,
        `PnL: ${fmtNum(item?.pnlPct, 2)}%`,
      ].join("\n");

    default:
      return [
        `**${symbol} • ${mode} • ${moveTxt}**`,
        `Prijs: ${price}`,
      ].join("\n");
  }
}

// ======================================================
// UID
// ======================================================
export function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
}

// ======================================================
// Push event
// Slaat alleen analytics/logging op in KV.
// GEEN directe Discord posting meer.
// Alle Discord routing loopt nu alleen via sendSignal().
// ======================================================
export async function pushEvent(funnel, eventData) {
  const dedupe = dedupeKey(funnel, eventData);

  try {
    const ok = await kv.set(dedupe, "1", { nx: true, ex: DEDUPE_TTL_SEC });
    if (!ok) return null;
  } catch {}

  const key = EVENTS_KEY(funnel);

  const event = {
    id: uid("evt"),
    ts: Date.now(),
    ...eventData,
  };

  if (typeof kv.lpush === "function" && typeof kv.ltrim === "function") {
    await kv.lpush(key, JSON.stringify(event));
    await kv.ltrim(key, 0, KEEP - 1);
  } else {
    const prev = (await kv.get(key)) || [];
    const arr = Array.isArray(prev) ? prev : [];
    arr.unshift(event);
    await kv.set(key, arr.slice(0, KEEP));
  }

  return event.id;
}

// ======================================================
// Read events
// ======================================================
export async function readEvents(funnel, limit = 2000) {
  const key = EVENTS_KEY(funnel);

  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(key, 0, Math.max(0, limit - 1));

      return (raw || [])
        .map((x) => {
          try {
            return typeof x === "string" ? JSON.parse(x) : x;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    }
  } catch {}

  const data = await kv.get(key);
  return Array.isArray(data) ? data.slice(0, limit) : [];
}