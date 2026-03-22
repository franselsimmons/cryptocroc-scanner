import { summarizeMainSnapshot } from "./analyze-main.js";
import { summarizeMoonDiags, summarizeMoonTrades } from "./moon/analyze-plus.js";
import { analyzePro } from "./analyze-pro.js";

export default async function handler(req, res) {
  const { secret, format } = req.query;
  if (secret !== "lara-roos") {
    return res.status(401).json({ ok: false });
  }

  try {
    // --- FETCH DATA ---
    const [mainRes, moonRes, proRes] = await Promise.all([
      fetch(`${process.env.BASE_URL}/api/latest?secret=${secret}`),
      fetch(`${process.env.BASE_URL}/api/moon/latest?secret=${secret}`),
      fetch(`${process.env.BASE_URL}/api/analyze-pro?secret=${secret}&format=json`)
    ]);

    const mainData = await mainRes.json();
    const moonData = await moonRes.json();
    const proData = await proRes.json();

    // --- MAIN ---
    const bullMain = summarizeMainSnapshot(mainData?.bull);
    const bearMain = summarizeMainSnapshot(mainData?.bear);

    // --- MOON ---
    const bullMoonDiag = summarizeMoonDiags(moonData?.bull?.diags || []);
    const bearMoonDiag = summarizeMoonDiags(moonData?.bear?.diags || []);

    const bullMoonTrades = summarizeMoonTrades(moonData?.bull?.trades || []);
    const bearMoonTrades = summarizeMoonTrades(moonData?.bear?.trades || []);

    // --- PRO ADVIES ---
    const advices = proData?.advices || [];

    if (format === "json") {
      return res.status(200).json({
        main: { bull: bullMain, bear: bearMain },
        moon: {
          bull: { diag: bullMoonDiag, trades: bullMoonTrades },
          bear: { diag: bearMoonDiag, trades: bearMoonTrades }
        },
        advices
      });
    }

    // --- HTML ---
    const html = `
    <html>
    <head>
      <title>CryptoCroc Dashboard</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body {
          font-family: -apple-system, sans-serif;
          background: #0b0f1a;
          color: #fff;
          padding: 16px;
        }
        h1 { margin-bottom: 20px; }
        .grid {
          display: grid;
          gap: 16px;
        }
        .card {
          background: #121a2b;
          padding: 16px;
          border-radius: 12px;
        }
        .title {
          font-size: 18px;
          margin-bottom: 10px;
          font-weight: bold;
        }
        ul { padding-left: 18px; }
        li { margin-bottom: 4px; }
        .badge {
          display: inline-block;
          padding: 4px 8px;
          border-radius: 8px;
          background: #1f2a44;
          margin-right: 6px;
          font-size: 12px;
        }
      </style>
    </head>
    <body>

      <h1>📊 CryptoCroc Dashboard</h1>

      <div class="grid">

        ${renderMain("BULL", bullMain)}
        ${renderMain("BEAR", bearMain)}

        ${renderMoon("MOON BULL", bullMoonDiag, bullMoonTrades)}
        ${renderMoon("MOON BEAR", bearMoonDiag, bearMoonTrades)}

        ${renderAdvices(advices)}

      </div>

    </body>
    </html>
    `;

    res.status(200).send(html);

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ---------------- COMPONENTS ----------------

function renderMain(label, d) {
  if (!d) return "";

  return `
  <div class="card">
    <div class="title">${label} MAIN</div>

    <div>
      <span class="badge">RADAR: ${d.stageCounts?.RADAR || 0}</span>
      <span class="badge">BUILDUP: ${d.stageCounts?.BUILDUP || 0}</span>
      <span class="badge">ALMOST: ${d.stageCounts?.ALMOST || 0}</span>
    </div>

    <p><b>TradeDesk:</b> ${d.tradeDesk?.status || "-"}</p>

    <p><b>Top bottlenecks:</b></p>
    <ul>
      ${(d.topChecklistFails || [])
        .slice(0, 5)
        .map(x => `<li>${x.key} — ${x.count}</li>`)
        .join("")}
    </ul>
  </div>
  `;
}

function renderMoon(label, diag, trades) {
  return `
  <div class="card">
    <div class="title">${label}</div>

    <p><b>Scans:</b> ${diag?.total || 0}</p>

    <p><b>Top blokkades:</b></p>
    <ul>
      ${(diag?.topFails || [])
        .slice(0, 5)
        .map(x => `<li>${x.key} — ${x.count}</li>`)
        .join("")}
    </ul>

    <p><b>Trades:</b></p>
    <ul>
      <li>Winrate: ${trades?.winRate || 0}%</li>
      <li>Avg Return: ${trades?.avgReturn || 0}%</li>
    </ul>
  </div>
  `;
}

function renderAdvices(list) {
  return `
  <div class="card">
    <div class="title">📌 Adviezen</div>
    <ul>
      ${list.slice(0, 5).map(a => `
        <li>
          <b>${a.title}</b><br/>
          ${a.description}<br/>
          Impact: ${a.impact}
        </li>
      `).join("")}
    </ul>
  </div>
  `;
}