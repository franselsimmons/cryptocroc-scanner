import { useEffect, useMemo, useState } from "react";

const API = "/api/analyze-all?format=json&secret=lara-roos";

// =============================
// HELPERS
// =============================
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
  return {
    id: coin.id || `${coin.symbol || "coin"}-${idx}`,
    symbol: coin.symbol || "UNKNOWN",
    stage: coin.stage || "-",
    score: Number(coin.score || 0),
    bottlenecks: safeArray(coin.bottlenecks),
    advice: safeArray(coin.advice),
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

// =============================
// AUTO INSIGHTS
// =============================
function buildInsights(data) {
  const all = [
    ...getSectionList(data, ["main", "problems"]),
    ...getSectionList(data, ["moon", "bull", "problems"]),
    ...getSectionList(data, ["moon", "bear", "problems"]),
    ...getSectionList(data, ["trade", "problems"]),
  ];

  let timing = 0;
  let liquidity = 0;
  let quality = 0;
  let market = 0;
  let total = 0;

  all.forEach(c => {
    c.bottlenecks.forEach(b => {
      const txt = String(b).toLowerCase();
      total++;
      if (txt.includes("timing")) timing++;
      if (txt.includes("liquid")) liquidity++;
      if (txt.includes("kwaliteit") || txt.includes("quality")) quality++;
      if (txt.includes("markt") || txt.includes("market")) market++;
    });
  });

  const pct = x => total === 0 ? 0 : Math.round((x / total) * 100);

  return [
    { label: `${pct(timing)}% faalt op timing`, advice: "Wacht op breakout + volume" },
    { label: `${pct(liquidity)}% liquidity probleem`, advice: "Trade high depth coins" },
    { label: `${pct(quality)}% slechte kwaliteit`, advice: "Alleen high conviction setups" },
    { label: `${pct(market)}% markt tegen`, advice: "Trade met BTC trend" },
  ];
}

// =============================
// COMPONENTS
// =============================
function CoinCard({ coin }) {
  return (
    <div className={`bg-zinc-900 p-4 rounded-xl border ${getBorderColor(coin.score)}`}>
      <div className="flex justify-between mb-2">
        <h3 className="font-bold">{coin.symbol}</h3>
        <span className={`px-2 py-1 rounded text-black ${getColor(coin.score)}`}>
          {coin.score}
        </span>
      </div>

      <div className="text-xs text-gray-400 mb-2">{coin.stage}</div>

      <div className="text-red-400 text-sm">
        {coin.bottlenecks.map((b,i)=>(<div key={i}>⚠ {b}</div>))}
      </div>

      <div className="text-green-400 text-sm mt-2">
        {coin.advice.map((a,i)=>(<div key={i}>✔ {a}</div>))}
      </div>
    </div>
  );
}

function Section({ title, list }) {
  const arr = safeArray(list);

  return (
    <div className="mb-10">
      <h2 className="text-xl font-bold mb-4">{title}</h2>

      <div className="grid md:grid-cols-3 gap-4">
        {arr.length === 0
          ? <div className="text-green-400">Geen problemen 🚀</div>
          : arr.map((c,i)=><CoinCard key={i} coin={c}/>)
        }
      </div>
    </div>
  );
}

// =============================
// MAIN
// =============================
export default function Dashboard() {
  const [data,setData] = useState(null);
  const [error,setError] = useState("");

  useEffect(()=>{
    fetch(API)
      .then(r=>r.json())
      .then(setData)
      .catch(()=>setError("API error"));
  },[]);

  if (!data) return <div className="p-10 text-white bg-black">Laden...</div>;

  const insights = buildInsights(data);

  return (
    <div className="bg-black text-white min-h-screen p-6">

      <h1 className="text-3xl font-bold mb-6">🚀 CryptoCroc AI Dashboard</h1>

      {/* INSIGHTS */}
      <div className="mb-10">
        <h2 className="text-xl font-bold mb-4">🔥 Auto Insights</h2>

        <div className="grid md:grid-cols-2 gap-4">
          {insights.map((i,idx)=>(
            <div key={idx} className="bg-zinc-900 p-4 rounded-xl">
              <div className="text-yellow-300">{i.label}</div>
              <div className="text-gray-400 text-sm">{i.advice}</div>
            </div>
          ))}
        </div>
      </div>

      <Section title="📊 MAIN" list={data.main?.problems}/>
      <Section title="🌙 MOON Bull" list={data.moon?.bull?.problems}/>
      <Section title="🌙 MOON Bear" list={data.moon?.bear?.problems}/>
      <Section title="💰 TRADE" list={data.trade?.problems}/>

    </div>
  );
}