// /api/analyze-main.js
import { kv } from "@vercel/kv";

export const config = { runtime: "nodejs" };


// ======================================================
// SECRET CHECK  (werkt met CRON_SECRET of CC_TOKEN)
// ======================================================
function requireSecret(req, res) {
  const got = String(req.query?.token || req.headers?.["x-token"] || "");

  const want = String(
    process.env.CRON_SECRET ||
    process.env.CC_TOKEN ||
    process.env.SECRET_TOKEN ||
    process.env.ADMIN_TOKEN ||
    ""
  );

  if (!want) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      ok: false,
      error: "Server missing token env var (CRON_SECRET / CC_TOKEN)"
    }));
    return false;
  }

  if (!got || got !== want) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return false;
  }

  return true;
}


// ======================================================
// KV KEYS
// ======================================================
const keyLatest = (mode) => `latest:${String(mode || "bull")}`;
const keyDiagList = (mode) => `diag:list:${String(mode || "bull")}`;
const keyDiagSnap = (mode) => `diag:snap:${String(mode || "bull")}`;
const keyTrades = (funnel) => `trades:${String(funnel || "main")}`;
const keyEvents = (funnel) => `events:${String(funnel || "main")}`;


// ======================================================
// HELPERS
// ======================================================
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}

function fmtDateMin(ms) {
  const d = new Date(Number(ms || 0));
  if (!Number.isFinite(d.getTime())) return "-";
  return d.toLocaleString("nl-NL", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function readLatestDiag(mode) {
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyDiagList(mode), 0, 0);
      const one = safeArr(raw)[0];
      if (!one) return null;
      return typeof one === "string" ? JSON.parse(one) : one;
    }
  } catch {}

  try {
    return await kv.get(keyDiagSnap(mode));
  } catch {
    return null;
  }
}

async function readTrades(funnel) {
  try {
    return safeArr(await kv.get(keyTrades(funnel)));
  } catch {
    return [];
  }
}

async function readEvents(funnel, max = 2000) {
  try {
    if (typeof kv.lrange === "function") {
      const raw = await kv.lrange(keyEvents(funnel), 0, max - 1);
      return safeArr(raw)
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
  return [];
}

function top2(mapObj) {
  const e = Object.entries(mapObj || {});
  e.sort((a, b) => (b[1] || 0) - (a[1] || 0));
  return e.slice(0, 2);
}


// ======================================================
// SUGGESTION ENGINE
// ======================================================
function suggestFromDiag(diag, label) {
  if (!diag) {
    return [
      `Geen diagnose voor ${label}. Draai eerst /api/scan?mode=...`
    ];
  }

  const counts = diag.counts || {};
  const reasons = diag.reasons || {};
  const entryGate = reasons.entryGate || {};
  const obReason = reasons.obReason || {};
  const uni = diag.universe || {};

  const sug = [];

  if ((counts.radar || 0) < 10) {
    sug.push(`Weinig RADAR (${counts.radar}). RADAR iets ruimer maken.`);
  }

  if ((counts.buildup || 0) > 20 && (counts.almost || 0) === 0) {
    sug.push(`Veel BUILDUP maar geen ALMOST. ALMOST iets versoepelen.`);
  }

  const te = top2(entryGate);
  if (te.length) {
    sug.push(`Top ENTRY blokkade: ${te[0][0]} (${te[0][1]}x)`);
  }

  const to = top2(obReason);
  if (to.length) {
    sug.push(`Top OB reden: ${to[0][0]} (${to[0][1]}x)`);
  }

  const afterUni = uni.afterSymbols || uni.afterBitget || 0;
  const afterRadar = uni.afterRadar || 0;

  if (afterUni > 0 && afterRadar / afterUni < 0.25) {
    sug.push(`RADAR filters zijn streng t.o.v. universe.`);
  }

  if (!sug.length) sug.push(`Ziet er gezond uit. Meer scans verzamelen.`);
  return sug;
}


// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const format = String(req.query?.format || "html").toLowerCase();

    const long = await kv.get(keyLatest("bull"));
    const short = await kv.get(keyLatest("bear"));

    const diagLong = await readLatestDiag("bull");
    const diagShort = await readLatestDiag("bear");

    const sugLong = suggestFromDiag(diagLong, "LONG");
    const sugShort = suggestFromDiag(diagShort, "SHORT");

    const trades = await readTrades("main");
    const events = await readEvents("main");

    if (format === "json") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({
        ok: true,
        latest: { long, short },
        diag: { long: diagLong, short: diagShort },
        suggestions: { long: sugLong, short: sugShort },
        analytics: {
          trades: trades.length,
          events: events.length
        }
      }));
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");

    return res.end(`
      <h1>Analyze MAIN (LONG vs SHORT)</h1>
      <h2>LONG</h2>
      <pre>${JSON.stringify({ latest: long, suggestions: sugLong }, null, 2)}</pre>
      <h2>SHORT</h2>
      <pre>${JSON.stringify({ latest: short, suggestions: sugShort }, null, 2)}</pre>
    `);

  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({
      ok: false,
      error: String(e?.message || e)
    }));
  }
}