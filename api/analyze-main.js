import { kv } from "@vercel/kv";
import {
  readTrades,
  readEvents,
  fmtTsMin,
  fmtDurMin,
} from "./_analytics.js";

export const config = { runtime: "nodejs20.x" };

const LEVERAGE = 10;

function safeNum(n) {
  return Number(n || 0);
}

function sideLabel(mode) {
  return mode === "bull" ? "LONG" : "SHORT";
}

function pct10x(pct) {
  return safeNum(pct) * LEVERAGE;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function buildStats(trades) {
  const closed = trades.filter(t => t.status === "CLOSED");

  const long = closed.filter(t => t.mode === "bull");
  const short = closed.filter(t => t.mode === "bear");

  const win = closed.filter(t => safeNum(t.pnlPct) > 0);
  const loss = closed.filter(t => safeNum(t.pnlPct) <= 0);

  const winRate = closed.length ? (win.length / closed.length) * 100 : 0;

  const avgWin = avg(win.map(t => safeNum(t.pnlPct)));
  const avgLoss = avg(loss.map(t => safeNum(t.pnlPct)));

  const avgLong = avg(long.map(t => safeNum(t.pnlPct)));
  const avgShort = avg(short.map(t => safeNum(t.pnlPct)));

  return {
    totalClosed: closed.length,
    winRate,
    avgWin,
    avgLoss,
    avgLong,
    avgShort,
    longCount: long.length,
    shortCount: short.length,
  };
}

function buildSuggestions(stats) {
  const sug = [];

  if (stats.avgLong > stats.avgShort) {
    sug.push("LONG presteert beter dan SHORT → focus meer op LONG setups.");
  } else if (stats.avgShort > stats.avgLong) {
    sug.push("SHORT presteert beter dan LONG → focus meer op SHORT setups.");
  }

  if (stats.winRate < 45) {
    sug.push("Winrate laag → verhoog Confidence drempel of OB-score.");
  }

  if (stats.avgLoss < -5) {
    sug.push("Gemiddeld verlies groot → SL dichter zetten.");
  }

  if (stats.avgWin < 4) {
    sug.push("Gemiddelde winst klein → TP verder zetten.");
  }

  if (!sug.length) {
    sug.push("Systeem stabiel. Alleen fine-tunen per marktconditie.");
  }

  return sug;
}

function renderHtml(stats, suggestions, trades) {
  return `
  <html>
  <head>
    <title>MAIN Analyze</title>
    <style>
      body { font-family: Arial; background:#0e1117; color:#fff; padding:20px }
      h1 { margin-bottom:10px }
      .card { background:#161b22; padding:15px; border-radius:8px; margin-bottom:15px }
      table { width:100%; border-collapse: collapse; }
      th,td { padding:8px; border-bottom:1px solid #222; text-align:left }
      th { color:#999 }
      .pos { color:#00ff88 }
      .neg { color:#ff4d4d }
    </style>
  </head>
  <body>

  <h1>MAIN Performance Analyze</h1>

  <div class="card">
    <b>Gesloten Trades:</b> ${stats.totalClosed}<br/>
    <b>Winrate:</b> ${stats.winRate.toFixed(1)}%<br/>
    <b>Gem. LONG:</b> ${stats.avgLong.toFixed(2)}%<br/>
    <b>Gem. SHORT:</b> ${stats.avgShort.toFixed(2)}%
  </div>

  <div class="card">
    <b>Automatische Suggesties:</b><br/>
    ${suggestions.map(s => "• " + s).join("<br/>")}
  </div>

  <div class="card">
    <b>Laatste Trades:</b>
    <table>
      <tr>
        <th>Coin</th>
        <th>Side</th>
        <th>Open</th>
        <th>Close</th>
        <th>Duur</th>
        <th>PNL</th>
        <th>PNL 10x</th>
      </tr>
      ${trades.slice(-20).reverse().map(t => {
        const pnl = safeNum(t.pnlPct);
        return `
        <tr>
          <td>${t.symbol}</td>
          <td>${sideLabel(t.mode)}</td>
          <td>${fmtTsMin(t.entryAt)}</td>
          <td>${fmtTsMin(t.exitAt)}</td>
          <td>${fmtDurMin(t.entryAt, t.exitAt)}</td>
          <td class="${pnl>=0?"pos":"neg"}">${pnl.toFixed(2)}%</td>
          <td class="${pnl>=0?"pos":"neg"}">${pct10x(pnl).toFixed(2)}%</td>
        </tr>
        `;
      }).join("")}
    </table>
  </div>

  </body>
  </html>
  `;
}

export default async function handler(req, res) {
  try {
    const token = String(req.query?.token || "");
    if (token !== process.env.CRON_SECRET) {
      return res.status(401).json({ ok:false, error:"Unauthorized" });
    }

    const format = String(req.query?.format || "html");

    const trades = await readTrades("main");

    const stats = buildStats(trades);
    const suggestions = buildSuggestions(stats);

    if (format === "json") {
      return res.json({
        ok:true,
        stats,
        suggestions
      });
    }

    const html = renderHtml(stats, suggestions, trades);

    res.setHeader("content-type","text/html");
    res.status(200).end(html);

  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
}