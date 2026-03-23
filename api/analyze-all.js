// api/analyze-all.js
// Dit bestand is een Next.js API route die een volledige HTML-pagina teruggeeft.
// Geen React, geen JSX, alleen server-side JavaScript.

export default async function handler(req, res) {
  // ============================================================
  // 1. Bepaal of de client JSON of HTML wil (via query parameter)
  // ============================================================
  const { format, secret } = req.query;

  // Optionele beveiliging
  if (secret !== "lara-roos") {
    return res.status(401).json({ error: "Ongeldige secret" });
  }

  // ============================================================
  // 2. Haal data op uit je KV store, database of berekeningen
  //    (Dit is een voorbeeld. Vervang dit door jouw echte logica)
  // ============================================================
  // Stel dat we de analyse-data hebben (bijv. uit KV of eigen logica)
  const analysisData = {
    main: {
      problems: [
        {
          id: "1",
          symbol: "BTC",
          stage: "Early",
          score: 8.2,
          bottlenecks: ["Liquiditeit laag"],
          advice: ["Wacht op meer volume"],
        },
        {
          id: "2",
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
            id: "3",
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
          id: "4",
          symbol: "DOGE",
          stage: "Volatile",
          score: 3.2,
          bottlenecks: ["Markt tegen", "Slechte kwaliteit"],
          advice: ["Niet traden"],
        },
      ],
    },
  };

  // ============================================================
  // 3. Als format=json is, geef JSON terug
  // ============================================================
  if (format === "json") {
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json(analysisData);
  }

  // ============================================================
  // 4. Anders: genereer HTML (dynamisch op basis van de data)
  // ============================================================
  const html = generateHTML(analysisData);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).end(html);
}

// --------------------------------------------------------------
// Helper functies om HTML te bouwen (geen React)
// --------------------------------------------------------------
function generateHTML(data) {
  const mainProblems = getSectionList(data, ["main", "problems"]);
  const moonBullProblems = getSectionList(data, ["moon", "bull", "problems"]);
  const moonBearProblems = getSectionList(data, ["moon", "bear", "problems"]);
  const tradeProblems = getSectionList(data, ["trade", "problems"]);
  const insights = buildInsights(data);

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CryptoCroc AI Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    /* Optionele extra stijlen */
    body { background-color: black; color: white; }
  </style>
</head>
<body class="bg-black text-white min-h-screen p-6">
  <h1 class="text-3xl font-bold mb-6">🚀 CryptoCroc AI Dashboard</h1>

  <!-- Auto Insights -->
  <div class="mb-10">
    <h2 class="text-xl font-bold mb-4">🔥 Auto Insights</h2>
    <div class="grid md:grid-cols-2 gap-4">
      ${insights
        .map(
          (i) => `
        <div class="bg-zinc-900 p-4 rounded-xl border border-zinc-800">
          <div class="font-semibold text-yellow-300">${escapeHtml(i.label)}</div>
          <div class="text-sm text-gray-400 mt-1">${escapeHtml(i.advice)}</div>
        </div>
      `
        )
        .join("")}
    </div>
  </div>

  <!-- Secties -->
  ${renderSection("📊 MAIN Funnel", mainProblems)}
  ${renderSection("🌙 MOON Bull", moonBullProblems)}
  ${renderSection("🌙 MOON Bear", moonBearProblems)}
  ${renderSection("💰 TRADE Funnel", tradeProblems)}
</body>
</html>`;
}

function renderSection(title, list) {
  const safeList = safeArray(list);
  if (safeList.length === 0) {
    return `
      <div class="mb-10">
        <h2 class="text-xl font-bold mb-4">${escapeHtml(title)}</h2>
        <div class="text-green-400 bg-zinc-900 p-4 rounded-xl border border-zinc-800">
          Geen problemen 🚀
        </div>
      </div>
    `;
  }
  const cards = safeList.map((coin, idx) => renderCoinCard(coin, idx)).join("");
  return `
    <div class="mb-10">
      <h2 class="text-xl font-bold mb-4">${escapeHtml(title)}</h2>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        ${cards}
      </div>
    </div>
  `;
}

function renderCoinCard(coin, idx) {
  const normalized = normalizeCoin(coin, idx);
  const bottlenecks = safeArray(normalized.bottlenecks);
  const advice = safeArray(normalized.advice);
  const borderColor = getBorderColor(normalized.score);
  const scoreColor = getColor(normalized.score);

  return `
    <div class="bg-zinc-900 p-4 rounded-xl border ${borderColor}">
      <div class="flex justify-between items-center mb-2 gap-3">
        <h3 class="font-bold truncate">${escapeHtml(normalized.symbol)}</h3>
        <span class="px-2 py-1 rounded text-black font-semibold ${scoreColor}">
          ${normalized.score}
        </span>
      </div>
      <div class="text-xs text-gray-400 mb-3">${escapeHtml(normalized.stage)}</div>

      <div class="mb-3">
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Bottlenecks</div>
        ${bottlenecks.length === 0 ? '<div class="text-sm text-gray-500">Geen bottlenecks</div>' : bottlenecks.map(b => `<div class="text-red-400 text-sm">⚠ ${escapeHtml(b)}</div>`).join("")}
      </div>

      <div>
        <div class="text-xs uppercase tracking-wide text-gray-500 mb-1">Advies</div>
        ${advice.length === 0 ? '<div class="text-sm text-gray-500">Geen advies</div>' : advice.map(a => `<div class="text-green-400 text-sm">✔ ${escapeHtml(a)}</div>`).join("")}
      </div>
    </div>
  `;
}

// --------------------------------------------------------------
// Hulpfuncties (identiek aan je React versie, maar dan voor server)
// --------------------------------------------------------------
function getColor(score) {
  if (score >= 8) return "bg-green-500";
  if (score >= 6) return "bg-yellow-400";
  return "bg-red-500";
}

function getBorderColor(score) {
  if (score >= 8) return "border-green-500/40";
  if (score >= 6) return "border-yellow-400/40";
  return "border-red-500/40";
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function normalizeCoin(coin = {}, idx = 0) {
  const bottlenecks = safeArray(coin.bottlenecks);
  const advice = safeArray(coin.advice);
  return {
    id: coin.id || `${coin.symbol || "coin"}-${idx}`,
    symbol: coin.symbol || "UNKNOWN",
    stage: coin.stage || "-",
    score: Number.isFinite(Number(coin.score)) ? Number(coin.score) : 0,
    bottlenecks,
    advice,
  };
}

function getSectionList(data, path) {
  try {
    const value = path.reduce((acc, key) => acc?.[key], data);
    return safeArray(value).map(normalizeCoin);
  } catch {
    return [];
  }
}

function buildInsights(data) {
  const all = [
    ...getSectionList(data, ["main", "problems"]),
    ...getSectionList(data, ["moon", "bull", "problems"]),
    ...getSectionList(data, ["moon", "bear", "problems"]),
    ...getSectionList(data, ["trade", "problems"]),
  ];

  const total = all.length || 1;

  let timing = 0;
  let liquidity = 0;
  let quality = 0;
  let market = 0;

  all.forEach((c) => {
    safeArray(c.bottlenecks).forEach((b) => {
      const txt = String(b || "").toLowerCase();
      if (txt.includes("timing")) timing++;
      if (txt.includes("liquiditeit") || txt.includes("liquidity")) liquidity++;
      if (txt.includes("kwaliteit") || txt.includes("quality")) quality++;
      if (txt.includes("markt") || txt.includes("market")) market++;
    });
  });

  return [
    {
      label: `${Math.round((timing / total) * 100)}% faalt op timing`,
      advice: "Wacht vaker op breakout + volume confirmatie",
    },
    {
      label: `${Math.round((liquidity / total) * 100)}% liquidity probleem`,
      advice: "Focus op coins met sterke orderbook depth",
    },
    {
      label: `${Math.round((quality / total) * 100)}% slechte kwaliteit`,
      advice: "Alleen high conviction setups traden",
    },
    {
      label: `${Math.round((market / total) * 100)}% markt tegen`,
      advice: "Trade alleen met BTC trend mee",
    },
  ];
}

function escapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}