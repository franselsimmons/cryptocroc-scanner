import scan from "./scan.js";
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };

// -------------------- AUTH (CRON_SECRET) --------------------
function requireCron(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // open = niet aangeraden, maar toegestaan
  const auth = req.headers?.authorization || "";
  if (auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.setHeader?.("content-type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

// -------------------- DISCORD --------------------
async function sendDiscord(webhook, title, description, color = 3066993) {
  if (!webhook) return;

  // Discord limiet: embed description max ~4096 chars
  const max = 3800;
  const chunks = [];
  let s = String(description || "");
  while (s.length > max) {
    chunks.push(s.slice(0, max));
    s = s.slice(max);
  }
  chunks.push(s);

  for (let i = 0; i < chunks.length; i++) {
    await fetch(webhook, {
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
  }
}

function fmtNum(x, d = 2) {
  const n = Number(x);
  if (!Number.isFinite(n)) return "-";
  return n.toFixed(d);
}

function coinLine(c) {
  const sym = c.symbol || c.ticker || "?";
  const ch = c.change24 ?? c.change ?? c.pct24 ?? 0;
  const vm = c.vm ?? c.vmRatio ?? c.vm_ratio ?? 0;
  const ob = c.obScore ?? c.ob_score ?? c.ob ?? null;
  const edge = c.edgeScore ?? c.edge ?? null;

  const sl = c.sl ?? c.stopLoss ?? null;
  const tp = c.tp ?? c.takeProfit ?? null;

  return `• **${sym}** | 24h: **${fmtNum(ch, 2)}%** | VM: ${fmtNum(vm, 2)} | OB: ${
    ob === null || ob === undefined ? "-" : fmtNum(ob, 3)
  } | Edge: ${edge === null || edge === undefined ? "-" : fmtNum(edge, 0)} | SL: ${
    sl === null || sl === undefined ? "-" : fmtNum(sl, 6)
  } | TP: ${tp === null || tp === undefined ? "-" : fmtNum(tp, 6)}`;
}

function formatStage(stageName, bullCoins = [], bearCoins = []) {
  const b = (bullCoins || []).slice(0, 12);
  const s = (bearCoins || []).slice(0, 12);
  if (b.length === 0 && s.length === 0) return null;

  let out = `**${stageName}**\n`;

  if (b.length) out += `\n🟢 **BULL**\n${b.map(coinLine).join("\n")}\n`;
  if (s.length) out += `\n🔴 **BEAR**\n${s.map(coinLine).join("\n")}\n`;

  return out.trim();
}

// -------------------- SCAN CALL (capture JSON) --------------------
async function callScan(mode) {
  let body = "";

  const req = {
    url: `/api/scan?mode=${mode}`,
    headers: {}, // scan zelf heeft geen auth nodig
    method: "GET",
  };

  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk) {
      if (chunk) body += String(chunk);
    },
  };

  await scan(req, res);

  // scan schrijft JSON; probeer te parsen
  try {
    return JSON.parse(body || "{}");
  } catch {
    return { ok: false, parseError: true, raw: body };
  }
}

// -------------------- SAFE EXTRACT (maakt ons ongevoelig voor kleine verschillen in output) --------------------
function getFunnelPayload(scanJson) {
  // verwacht: { funnel: { radar:[], buildup:[], almost:[], entry:[] } }
  if (scanJson?.funnel) return scanJson.funnel;

  // fallback als jij ooit andere key gebruikt:
  if (scanJson?.tables) return scanJson.tables;

  // anders leeg
  return { radar: [], buildup: [], almost: [], entry: [] };
}

function signatureOfStage(bullCoins, bearCoins) {
  const b = (bullCoins || []).map((x) => x.symbol || x.ticker || "").filter(Boolean).sort();
  const s = (bearCoins || []).map((x) => x.symbol || x.ticker || "").filter(Boolean).sort();
  return JSON.stringify({ b, s });
}

async function postIfChanged(stageKey, webhook, title, text, sig) {
  if (!text) return;

  // KV is er bij jou, maar als KV ooit faalt: post gewoon
  try {
    const key = `cc:discord:last:${stageKey}`;
    const last = await kv.get(key);

    if (last === sig) return; // niets veranderd -> geen spam
    await kv.set(key, sig);

    await sendDiscord(webhook, title, text);
  } catch {
    // fallback: als KV stuk is, post alsnog (liever signaal dan stilte)
    await sendDiscord(webhook, title, text);
  }
}

// -------------------- HANDLER --------------------
export default async function handler(req, res) {
  try {
    if (!requireCron(req, res)) return;

    // 1) scan bull + bear (en KV memory wordt door scan.js bijgewerkt)
    const bull = await callScan("bull");
    const bear = await callScan("bear");

    // 2) funnel eruit halen
    const bullF = getFunnelPayload(bull);
    const bearF = getFunnelPayload(bear);

    // 3) webhooks
    const W_RADAR = process.env.DISCORD_WEBHOOK_RADAR;
    const W_BUILD = process.env.DISCORD_WEBHOOK_BUILDUP;
    const W_ALMOST = process.env.DISCORD_WEBHOOK_ALMOST;
    const W_ELITE = process.env.DISCORD_WEBHOOK_ELITE;

    // 4) berichten per tabel
    const radarText = formatStage("RADAR", bullF.radar, bearF.radar);
    const buildupText = formatStage("BUILDUP", bullF.buildup, bearF.buildup);
    const almostText = formatStage("ALMOST", bullF.almost, bearF.almost);
    const eliteText = formatStage("ENTRY / HOLD / SELL", bullF.entry, bearF.entry);

    // 5) anti-spam signatures
    const radarSig = signatureOfStage(bullF.radar, bearF.radar);
    const buildupSig = signatureOfStage(bullF.buildup, bearF.buildup);
    const almostSig = signatureOfStage(bullF.almost, bearF.almost);
    const eliteSig = signatureOfStage(bullF.entry, bearF.entry);

    // 6) post alleen als veranderd
    await postIfChanged("radar", W_RADAR, "📡 CryptoCroc — RADAR", radarText, radarSig);
    await postIfChanged("buildup", W_BUILD, "🧱 CryptoCroc — BUILDUP", buildupText, buildupSig);
    await postIfChanged("almost", W_ALMOST, "⚡ CryptoCroc — ALMOST", almostText, almostSig);
    await postIfChanged("elite", W_ELITE, "🚀 CryptoCroc — ENTRY / HOLD / SELL", eliteText, eliteSig);

    // 7) response
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: true,
        ts: Date.now(),
        posted: {
          radar: !!radarText,
          buildup: !!buildupText,
          almost: !!almostText,
          elite: !!eliteText,
        },
      })
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader?.("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}