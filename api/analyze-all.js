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

// =============================
// AUTO INSIGHTS ENGINE (FIXED)
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
  let totalBottlenecks = 0;

  all.forEach((c) => {
    safeArray(c.bottlenecks).forEach((b) => {
      const txt = String(b || "").toLowerCase();

      totalBottlenecks++;

      if (txt.includes("timing")) timing++;
      if (txt.includes("liquiditeit") || txt.includes("liquidity")) liquidity++;
      if (txt.includes("kwaliteit") || txt.includes("quality")) quality++;
      if (txt.includes("markt") || txt.includes("market")) market++;
    });
  });

  const pct = (x) =>
    totalBottlenecks === 0 ? 0 : Math.round((x / totalBottlenecks) * 100);

  return [
    {
      label: `${pct(timing)}% faalt op timing`,
      advice: "Wacht vaker op breakout + volume confirmatie",
    },
    {
      label: `${pct(liquidity)}% liquidity probleem`,
      advice: "Focus op coins met sterke orderbook depth",
    },
    {
      label: `${pct(quality)}% slechte kwaliteit`,
      advice: "Alleen high conviction setups traden",
    },
    {
      label: `${pct(market)}% markt tegen`,
      advice: "Trade alleen met BTC trend mee",
    },
  ];
}

// =============================
// COMPONENTS
// =============================
function CoinCard({ coin }) {
  const bottlenecks = safeArray(coin.bottlenecks);
  const advice = safeArray(coin.advice);

  return (
    <div className={`bg-zinc-900 p-4 rounded-xl border ${getBorderColor(coin.score)}`}>
      <div className="flex justify-between items-center mb-2 gap-3">
        <h3 className="font-bold truncate">{coin.symbol}</h3>
        <span className={`px-2 py-1 rounded text-black font-semibold ${getColor(coin.score)}`}>
          {coin.score}
        </span>
      </div>

      <div className="text-xs text-gray-400 mb-3">{coin.stage}</div>

      <div className="mb-3">
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Bottlenecks</div>
        {bottlenecks.length === 0 ? (
          <div className="text-sm text-gray-500">Geen bottlenecks</div>
        ) : (
          bottlenecks.map((b, i) => (
            <div key={i} className="text-red-400 text-sm">
              ⚠ {b}
            </div>
          ))
        )}
      </div>

      <div>
        <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Advies</div>
        {advice.length === 0 ? (
          <div className="text-sm text-gray-500">Geen advies</div>
        ) : (
          advice.map((a, i) => (
            <div key={i} className="text-green-400 text-sm">
              ✔ {a}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Section({ title, list }) {
  const safeList = safeArray(list);

  return (
    <div className="mb-10">
      <h2 className="text-xl font-bold mb-4">{title}</h2>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {safeList.length === 0 ? (
          <div className="text-green-400 bg-zinc-900 p-4 rounded-xl border border-zinc-800">
            Geen problemen 🚀
          </div>
        ) : (
          safeList.map((c, i) => <CoinCard key={c.id || i} coin={normalizeCoin(c, i)} />)
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
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;

    async function load() {
      try {
        setError("");

        const r = await fetch(API);
        const text = await r.text();

        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("API geeft geen geldige JSON terug");
        }

        if (!r.ok) {
          throw new Error(json?.error || `API fout (${r.status})`);
        }

        if (alive) setData(json);
      } catch (e) {
        if (alive) {
          setError(e?.message || "Onbekende fout");
          setData({});
        }
      }
    }

    load();
    return () => {
      alive = false;
    };
  }, []);

  const mainProblems = useMemo(() => getSectionList(data, ["main", "problems"]), [data]);
  const moonBullProblems = useMemo(() => getSectionList(data, ["moon", "bull", "problems"]), [data]);
  const moonBearProblems = useMemo(() => getSectionList(data, ["moon", "bear", "problems"]), [data]);
  const tradeProblems = useMemo(() => getSectionList(data, ["trade", "problems"]), [data]);
  const insights = useMemo(() => buildInsights(data), [data]);

  if (!data && !error) {
    return (
      <div className="p-10 text-white bg-black min-h-screen">
        Laden...
      </div>
    );
  }

  return (
    <div className="bg-black text-white min-h-screen p-6">
      <h1 className="text-3xl font-bold mb-6">
        🚀 CryptoCroc AI Dashboard
      </h1>

      {error ? (
        <div className="mb-8 bg-red-950 border border-red-700 text-red-300 p-4 rounded-xl">
          <div className="font-semibold mb-1">API fout</div>
          <div className="text-sm">{error}</div>
        </div>
      ) : null}

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

      <Section title="📊 MAIN Funnel" list={mainProblems} />
      <Section title="🌙 MOON Bull" list={moonBullProblems} />
      <Section title="🌙 MOON Bear" list={moonBearProblems} />
      <Section title="💰 TRADE Funnel" list={tradeProblems} />
    </div>
  );
}