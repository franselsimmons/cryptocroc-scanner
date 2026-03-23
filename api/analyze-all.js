export default async function handler(req, res) {
  const format = req.query.format;

  const data = {
    main: {
      problems: [
        {
          symbol: "BTC",
          stage: "Early",
          score: 8.2,
          bottlenecks: ["Liquiditeit laag"],
          advice: ["Wacht op meer volume"],
        },
        {
          symbol: "ETH",
          stage: "Mid",
          score: 5.1,
          bottlenecks: ["Timing mismatch"],
          advice: ["Breakout afwachten"],
        },
      ],
    },
    moon: {
      bull: {
        problems: [
          {
            symbol: "SOL",
            stage: "Bull Run",
            score: 9.5,
            bottlenecks: [],
            advice: ["HODL"],
          },
        ],
      },
      bear: {
        problems: [],
      },
    },
    trade: {
      problems: [
        {
          symbol: "DOGE",
          stage: "Volatile",
          score: 3.2,
          bottlenecks: ["Markt tegen", "Slechte kwaliteit"],
          advice: ["Niet traden"],
        },
      ],
    },
  };

  // =============================
  // JSON MODE
  // =============================
  if (format === "json") {
    return res.status(200).json(data);
  }

  // =============================
  // HTML DASHBOARD (INLINE)
  // =============================
  res.setHeader("Content-Type", "text/html");

  return res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>CryptoCroc AI</title>
      <style>
        body {
          background: #000;
          color: #fff;
          font-family: Arial;
          padding: 20px;
        }
        .card {
          background: #111;
          padding: 15px;
          margin-bottom: 10px;
          border-radius: 10px;
        }
        .green { color: #22c55e }
        .yellow { color: #facc15 }
        .red { color: #ef4444 }
      </style>
    </head>
    <body>

      <h1>🚀 CryptoCroc AI Dashboard</h1>

      <h2>📊 MAIN</h2>
      ${data.main.problems.map(c => `
        <div class="card">
          <b>${c.symbol}</b> (${c.stage}) - ${c.score}
          <div class="red">⚠ ${c.bottlenecks.join(", ")}</div>
          <div class="green">✔ ${c.advice.join(", ")}</div>
        </div>
      `).join("")}

      <h2>🌙 MOON Bull</h2>
      ${data.moon.bull.problems.map(c => `
        <div class="card">
          <b>${c.symbol}</b> - ${c.score}
          <div class="green">✔ ${c.advice.join(", ")}</div>
        </div>
      `).join("")}

      <h2>🌙 MOON Bear</h2>
      ${
        data.moon.bear.problems.length === 0
          ? `<div class="green">Geen problemen 🚀</div>`
          : ""
      }

      <h2>💰 TRADE</h2>
      ${data.trade.problems.map(c => `
        <div class="card">
          <b>${c.symbol}</b> - ${c.score}
          <div class="red">⚠ ${c.bottlenecks.join(", ")}</div>
          <div class="green">✔ ${c.advice.join(", ")}</div>
        </div>
      `).join("")}

    </body>
    </html>
  `);
}