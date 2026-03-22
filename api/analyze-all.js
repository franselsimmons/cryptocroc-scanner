import { kv } from "@vercel/kv";
import * as moonCore from "../lib/_moon_core.js";

export default async function handler(req, res) {
  const { secret } = req.query;
  if (secret !== "lara-roos") return res.status(401).end();

  const pro = await fetch(
    `${process.env.BASE_URL}/api/analyze-pro?secret=${secret}`
  ).then((r) => r.json());

  function renderScore(label, val) {
    return `<div><b>${label}</b>: ${val}/10</div>`;
  }

  const html = `
  <html>
  <body style="background:#0b0f14;color:white;font-family:sans-serif;padding:20px">

  <h1>🔥 SYSTEM DIAGNOSE</h1>

  <h2>Main Bull</h2>
  ${renderScore("BTC alignment", pro.main.bull.btcAlignment)}
  ${renderScore("Breakout", pro.main.bull.breakout)}
  ${renderScore("Persistence", pro.main.bull.persistence)}
  ${renderScore("Entry", pro.main.bull.entryQuality)}

  <h2>Main Bear</h2>
  ${renderScore("BTC alignment", pro.main.bear.btcAlignment)}
  ${renderScore("Breakout", pro.main.bear.breakout)}
  ${renderScore("Persistence", pro.main.bear.persistence)}
  ${renderScore("Entry", pro.main.bear.entryQuality)}

  <h2>Moon Bull</h2>
  ${renderScore("Elite filter", pro.moon.bull.eliteFilter)}
  ${renderScore("Liquidity", pro.moon.bull.liquidity)}
  ${renderScore("Stability", pro.moon.bull.stability)}

  <h2>Moon Bear</h2>
  ${renderScore("Elite filter", pro.moon.bear.eliteFilter)}
  ${renderScore("Liquidity", pro.moon.bear.liquidity)}
  ${renderScore("Stability", pro.moon.bear.stability)}

  <h2>Trades</h2>
  ${renderScore("Giveback", pro.trades.givebackScore)}
  ${renderScore("Loss rate", pro.trades.lossRateScore)}

  </body>
  </html>
  `;

  res.send(html);
}