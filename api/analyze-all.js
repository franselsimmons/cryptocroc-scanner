import { useEffect, useState } from "react";

const API = "/api/analyze-all?secret=lara-roos";

// =============================
// HELPERS
// =============================
function getColor(score) {
  if (score >= 8) return "bg-green-500";
  if (score >= 6) return "bg-yellow-400";
  return "bg-red-500";
}

function getTextColor(score) {
  if (score >= 8) return "text-green-400";
  if (score >= 6) return "text-yellow-300";
  return "text-red-400";
}

// =============================
// AUTO INSIGHTS ENGINE
// =============================
function buildInsights(data) {
  const all = [
    ...(data?.main?.problems || []),
    ...(data?.moon?.bull?.problems || []),
    ...(data?.moon?.bear?.problems || []),
    ...(data?.trade?.problems || []),
  ];

  const total = all.length || 1;

  let timing = 0;
  let liquidity = 0;
  let quality = 0;
  let market = 0;

  all.forEach(c => {
    c.bottlenecks?.forEach(b => {
      if (b.includes("timing")) timing++;
      if (b.includes("liquiditeit")) liquidity++;
      if (b.includes("kwaliteit")) quality++;
      if (b.includes("markt")) market++;
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

// =============================
// COMPONENTS
// =============================
function CoinCard({ coin }) {
  return (
    <div className="bg-zinc-900 p-4 rounded-xl border border-zinc-800">
      <div className="flex justify-between items-center mb-2">
        <h3 className="font-bold">{coin.symbol}</h3>
        <span className={`px-2 py-1 rounded ${getColor(coin.score)}`}>
          {coin.score}
        </span>
      </div>

      <div className="text-xs text-gray-400 mb-2">{coin.stage}</div>

      <div className="mb-2">
        {coin.bottlenecks.map((b, i) => (
          <div key={i} className="text-red-400 text-sm">
            ⚠ {b}
          </div>
        ))}
      </div>

      <div>
        {coin.advice.map((a, i) => (
          <div key={i} className="text-green-400 text-sm">
            ✔ {a}
          </div>
        ))}
      </div>
    </div>
  );
}

function Section({ title, list }) {
  return (
    <div className="mb-10">
      <h2 className="text-xl font-bold mb-4">{title}</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {list.length === 0 ? (
          <div className="text-green-400">Geen problemen 🚀</div>
        ) : (
          list.map((c, i) => <CoinCard key={i} coin={c} />)
        )}
      </div>
    </div>
  );
}

// =============================
// MAIN
// =============================
export default function Dashboard() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch(API)
      .then(r => r.json())
      .then(setData);
  }, []);

  if (!data) {
    return (
      <div className="p-10 text-white bg-black min-h-screen">
        Laden...
      </div>
    );
  }

  const insights = buildInsights(data);

  return (
    <div className="bg-black text-white min-h-screen p-6">

      {/* HEADER */}
      <h1 className="text-3xl font-bold mb-6">
        🚀 CryptoCroc AI Dashboard
      </h1>

      {/* INSIGHTS */}
      <div className="mb-10">
        <h2 className="text-xl font-bold mb-4">🔥 Auto Insights</h2>

        <div className="grid md:grid-cols-2 gap-4">
          {insights.map((i, idx) => (
            <div key={idx} className="bg-zinc-900 p-4 rounded-xl border border-zinc-800">
              <div className="font-semibold text-yellow-300">
                {i.label}
              </div>
              <div className="text-sm text-gray-400 mt-1">
                {i.advice}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* MAIN */}
      <Section title="📊 MAIN Funnel" list={data.main.problems} />

      {/* MOON */}
      <Section title="🌙 MOON Bull" list={data.moon.bull.problems} />
      <Section title="🌙 MOON Bear" list={data.moon.bear.problems} />

      {/* TRADE */}
      <Section title="💰 TRADE Funnel" list={data.trade.problems} />

    </div>
  );
}