// ================= RUNNER DISCORD NOTIFIER =================

const WEBHOOK_A = String(
  process.env.DISCORD_WEBHOOK_RUNNER_A ||
  process.env.DISCORD_WEBHOOK_A ||
  ""
).trim();

const WEBHOOK_B = String(
  process.env.DISCORD_WEBHOOK_RUNNER_B ||
  process.env.DISCORD_WEBHOOK_B ||
  ""
).trim();

const WEBHOOK_C = String(
  process.env.DISCORD_WEBHOOK_RUNNER_C ||
  process.env.DISCORD_WEBHOOK_C ||
  WEBHOOK_B ||
  WEBHOOK_A ||
  ""
).trim();

const fetchFn = globalThis.fetch;

const FOOTER_TEXT = "Runner Trade System ⚡";
const MAX_RETRIES = 3;
const COOLDOWN_MINUTES = Number(process.env.RUNNER_SIGNAL_COOLDOWN_MINUTES || 20);

const recentSignals = new Map();

function getWebhook(grade) {
  const g = String(grade || "C").toUpperCase();

  if (g === "A") return WEBHOOK_A;
  if (g === "B") return WEBHOOK_B;

  return WEBHOOK_C;
}

function toText(value, fallback = "N/A") {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function compactNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return n.toFixed(8).replace(/\.?0+$/, "");
}

function compactPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "N/A";
  return `${n.toFixed(3).replace(/\.?0+$/, "")}%`;
}

function limit(text, max) {
  const s = toText(text, "");
  if (s.length <= max) return s || "N/A";
  return `${s.slice(0, max - 1)}…`;
}

function normalizeSide(side) {
  return String(side || "").toLowerCase() === "bear" ? "bear" : "bull";
}

function buildSignalKey(t) {
  const symbol = String(t?.symbol || "UNKNOWN").toUpperCase();
  const side = normalizeSide(t?.side);
  const entryType = String(t?.entryType || t?.runnerEntryType || "RUNNER").toUpperCase();

  return `${symbol}_${side}_${entryType}`;
}

function buildEmbed({ title, color, description }) {
  return {
    title: limit(title, 256),
    description: limit(description, 4096),
    color,
    footer: { text: FOOTER_TEXT },
    timestamp: new Date().toISOString()
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendMessage(webhook, message) {
  if (!webhook || !fetchFn) return;

  let lastError = null;

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const res = await fetchFn(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(message)
      });

      if (res.ok) return;

      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        const wait = Math.ceil(Number(data?.retry_after || 1.5) * 1000);
        await sleep(wait);
        continue;
      }

      lastError = await res.text();
    } catch (e) {
      lastError = e.message;
    }

    await sleep(1000 * i);
  }

  if (lastError) {
    console.error("RUNNER DISCORD ERROR:", lastError);
  }
}

function getColor(t) {
  const grade = String(t?.grade || "C").toUpperCase();
  const flow = String(t?.flow || "").toUpperCase();

  if (grade === "A" || flow === "SQUEEZE") return 0x00ff99;
  if (grade === "B" || flow === "RUNNING") return 0xf1c40f;

  return 0x3498db;
}

function formatEntryMessage(t) {
  const side = normalizeSide(t?.side);
  const direction = side === "bull" ? "📈 LONG" : "📉 SHORT";
  const grade = toText(t.grade || "?");

  const entry = compactNumber(t.entry);
  const tp = compactNumber(t.tp);
  const sl = compactNumber(t.sl);
  const rr = compactNumber(t.rr);

  const runnerScore = toText(
    t.runnerScore ?? t.moveScore ?? t.score,
    "N/A"
  );

  const pressure = compactNumber(t.runnerPressure);
  const acceleration = compactNumber(t.runnerAcceleration);
  const freshness = toText(t.freshness, "N/A");

  const cb = "```";

  return `
⚡ **${toText(t.symbol)} ${direction} RUNNER (${grade})**

Type: **${toText(t.entryType || t.runnerEntryType || "RUNNER")}**
Flow: **${toText(t.flow)}**
Stage: **${toText(t.stage || t.scannerStage)}**

📥 ENTRY: \`${entry}\`
🎯 TP: \`${tp}\`
🛑 SL: \`${sl}\`
📊 RR: **${rr}**

━━━━━━━━━━━━━━━
📋 **SNEL KOPIËREN**

ENTRY
${cb}${entry}${cb}

TP
${cb}${tp}${cb}

SL
${cb}${sl}${cb}

━━━━━━━━━━━━━━━
⚙️ Runner Score: **${runnerScore}**
🧲 Confluence: **${toText(t.confluence)}**
🔥 Pressure: **${pressure}**
🚀 Acceleration: **${acceleration}**
⏱ Freshness: **${freshness}**
📉 Funding: **${compactPct(t.funding)}**
`;
}

function formatExitMessage(t) {
  const reason = String(t.reason || "").toUpperCase();
  const isWin = reason === "TP" || reason === "TAKE_PROFIT";
  const isTrail = reason === "TRAIL" || reason === "TRAILING_STOP";

  const tp = compactNumber(t.tp);
  const sl = compactNumber(t.sl);
  const rr = compactNumber(t.rr);
  const pnl = compactPct(t.pnlPct);

  if (isWin) {
    return `
✅ **RUNNER TP geraakt op ${toText(t.symbol)}**

🎯 TP: \`${tp}\`
💰 RR: **${rr}**
📊 PnL: **${pnl}**
`;
  }

  if (isTrail) {
    return `
🔁 **RUNNER trailing exit op ${toText(t.symbol)}**

📊 PnL: **${pnl}**
💰 RR: **${rr}**
Reason: **${toText(t.reason)}**
`;
  }

  return `
❌ **RUNNER SL geraakt op ${toText(t.symbol)}**

🛑 SL: \`${sl}\`
📊 PnL: **${pnl}**
Reason: **${toText(t.reason)}**
`;
}

export async function sendEntry(t) {
  const symbol = t.symbol || "UNKNOWN";
  const now = Date.now();
  const cooldownMs = COOLDOWN_MINUTES * 60 * 1000;
  const key = buildSignalKey(t);

  const lastSent = recentSignals.get(key);

  if (lastSent && now - lastSent < cooldownMs) {
    console.log(`RUNNER DISCORD COOLDOWN: ${key}`);
    return;
  }

  recentSignals.set(key, now);

  const webhook = getWebhook(t.grade || "C");
  if (!webhook) return;

  const embed = buildEmbed({
    title: `${symbol} Runner Signal`,
    color: getColor(t),
    description: formatEntryMessage(t)
  });

  await sendMessage(webhook, { embeds: [embed] });
}

export async function sendExit(t) {
  const symbol = t.symbol || "UNKNOWN";
  const webhook = getWebhook(t.grade || "C");

  if (!webhook) return;

  const reason = String(t.reason || "").toUpperCase();

  const embed = buildEmbed({
    title: `${symbol} Runner Exit`,
    color: reason === "TP" || reason === "TAKE_PROFIT" ? 0x2ecc71 : 0xe74c3c,
    description: formatExitMessage(t)
  });

  await sendMessage(webhook, { embeds: [embed] });
}

export function clearDiscordCooldowns() {
  recentSignals.clear();

  return {
    ok: true,
    cleared: true,
    profile: "RUNNER",
    at: Date.now()
  };
}