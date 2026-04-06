import { useEffect, useState } from "react";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function fmtPct(v) {
  return `${n(v, 0).toFixed(2)}%`;
}

function fmtUsd(v) {
  return `$${n(v, 0).toFixed(2)}`;
}

function fmtTs(ts) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString("nl-NL");
  } catch {
    return "-";
  }
}

function StatCard({ title, value, sub }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>{title}</div>
      <div style={styles.cardValue}>{value}</div>
      {sub ? <div style={styles.cardSub}>{sub}</div> : null}
    </div>
  );
}

function SimpleTable({ title, rows, columns }) {
  return (
    <div style={styles.panel}>
      <h3 style={styles.h3}>{title}</h3>
      <div style={{ overflowX: "auto" }}>
        <table style={styles.table}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} style={styles.th}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((row, idx) => (
              <tr key={`${title}-${idx}`}>
                {columns.map((col) => (
                  <td key={col.key} style={styles.td}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
            {!rows?.length ? (
              <tr>
                <td style={styles.td} colSpan={columns.length}>Geen data</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AnalyzeAllPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setLoading(true);
      setErr("");
      const res = await fetch("/api/analyze-all");
      const json = await res.json();
      if (!json?.ok) throw new Error(json?.error || "Load failed");
      setData(json);
    } catch (e) {
      setErr(e?.message || "Onbekende fout");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const trades = data?.overview?.trades || {};
  const moon = data?.tradeBooks?.moon || {};
  const all = data?.tradeBooks?.all || {};
  const mainBull = data?.overview?.main?.bull || null;
  const mainBear = data?.overview?.main?.bear || null;
  const moonBull = data?.overview?.moon?.bull || null;
  const moonBear = data?.overview?.moon?.bear || null;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.h1}>Analyze All</h1>
          <div style={styles.muted}>Laatste refresh: {fmtTs(data?.ts)}</div>
        </div>
        <button onClick={load} style={styles.button}>
          Refresh
        </button>
      </div>

      {loading ? <div style={styles.panel}>Laden...</div> : null}
      {err ? <div style={{ ...styles.panel, color: "#ff8b8b" }}>{err}</div> : null}

      {!loading && !err && data ? (
        <>
          <div style={styles.grid}>
            <StatCard title="Closed trades" value={trades.closed || 0} />
            <StatCard title="Live trades" value={trades.live || 0} />
            <StatCard title="Win rate" value={fmtPct(trades.winRate)} />
            <StatCard title="Total PnL USD" value={fmtUsd(trades.totalPnlUsd)} />
            <StatCard title="Total PnL %" value={fmtPct(trades.totalPnlPct)} />
            <StatCard title="Moon closed" value={moon?.summary?.closed || 0} />
          </div>

          <div style={styles.twoCol}>
            <div style={styles.panel}>
              <h2 style={styles.h2}>Main Scanner Snapshot</h2>
              <div style={styles.snapshotBox}>
                <div>
                  <strong>Bull</strong>
                  <div>Regime: {mainBull?.regime || "-"}</div>
                  <div>Trade Ready: {mainBull?.counts?.trade_ready || 0}</div>
                  <div>Almost: {mainBull?.counts?.almost || 0}</div>
                  <div>Buildup: {mainBull?.counts?.buildup || 0}</div>
                  <div>Radar: {mainBull?.counts?.radar || 0}</div>
                </div>
                <div>
                  <strong>Bear</strong>
                  <div>Regime: {mainBear?.regime || "-"}</div>
                  <div>Trade Ready: {mainBear?.counts?.trade_ready || 0}</div>
                  <div>Almost: {mainBear?.counts?.almost || 0}</div>
                  <div>Buildup: {mainBear?.counts?.buildup || 0}</div>
                  <div>Radar: {mainBear?.counts?.radar || 0}</div>
                </div>
              </div>
            </div>

            <div style={styles.panel}>
              <h2 style={styles.h2}>Moon Snapshot</h2>
              <div style={styles.snapshotBox}>
                <div>
                  <strong>Bull</strong>
                  <div>Regime: {moonBull?.regime || "-"}</div>
                  <div>Hold: {moonBull?.counts?.hold || 0}</div>
                  <div>Almost: {moonBull?.counts?.almost || 0}</div>
                  <div>Buildup: {moonBull?.counts?.buildup || 0}</div>
                  <div>Radar: {moonBull?.counts?.radar || 0}</div>
                </div>
                <div>
                  <strong>Bear</strong>
                  <div>Regime: {moonBear?.regime || "-"}</div>
                  <div>Hold: {moonBear?.counts?.hold || 0}</div>
                  <div>Almost: {moonBear?.counts?.almost || 0}</div>
                  <div>Buildup: {moonBear?.counts?.buildup || 0}</div>
                  <div>Radar: {moonBear?.counts?.radar || 0}</div>
                </div>
              </div>
            </div>
          </div>

          <SimpleTable
            title="Recent closed trades"
            rows={all?.recentClosed || []}
            columns={[
              { key: "symbol", label: "Symbol" },
              { key: "side", label: "Side" },
              { key: "mode", label: "Mode" },
              { key: "stage", label: "Stage" },
              { key: "pnlPct", label: "PnL %", render: (r) => fmtPct(r.pnlPct) },
              { key: "pnlUsd", label: "PnL USD", render: (r) => fmtUsd(r.pnlUsd) },
              { key: "reason", label: "Reason" },
              { key: "closedAt", label: "Closed at", render: (r) => fmtTs(r.closedAt) },
            ]}
          />

          <div style={styles.twoCol}>
            <SimpleTable
              title="Best / worst per symbol"
              rows={all?.bySymbol || []}
              columns={[
                { key: "key", label: "Symbol" },
                { key: "count", label: "Trades" },
                { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
                { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
                { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
              ]}
            />

            <SimpleTable
              title="Reason breakdown"
              rows={all?.byReason || []}
              columns={[
                { key: "key", label: "Reason" },
                { key: "count", label: "Count" },
                { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
                { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
                { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
              ]}
            />
          </div>

          <SimpleTable
            title="Live trades"
            rows={all?.liveTrades || []}
            columns={[
              { key: "symbol", label: "Symbol" },
              { key: "side", label: "Side" },
              { key: "mode", label: "Mode" },
              { key: "stage", label: "Stage" },
              { key: "entryPrice", label: "Entry", render: (r) => n(r.entryPrice, 0).toFixed(8) },
              { key: "tp", label: "TP", render: (r) => n(r.tp, 0).toFixed(8) },
              { key: "sl", label: "SL", render: (r) => n(r.sl, 0).toFixed(8) },
              { key: "ts", label: "Opened", render: (r) => fmtTs(r.ts) },
            ]}
          />
        </>
      ) : null}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#08111f",
    color: "#f4f7fb",
    padding: 24,
    fontFamily: "Inter, Arial, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    marginBottom: 24,
  },
  h1: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.1,
  },
  h2: {
    margin: "0 0 12px 0",
    fontSize: 22,
  },
  h3: {
    margin: "0 0 12px 0",
    fontSize: 18,
  },
  muted: {
    opacity: 0.75,
    marginTop: 6,
  },
  button: {
    background: "#12305f",
    color: "#fff",
    border: "1px solid #2855a0",
    borderRadius: 12,
    padding: "10px 16px",
    cursor: "pointer",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 14,
    marginBottom: 20,
  },
  card: {
    background: "#0d1830",
    border: "1px solid #1c2b4f",
    borderRadius: 18,
    padding: 16,
  },
  cardTitle: {
    opacity: 0.75,
    fontSize: 13,
    marginBottom: 8,
  },
  cardValue: {
    fontSize: 28,
    fontWeight: 700,
  },
  cardSub: {
    opacity: 0.7,
    marginTop: 6,
    fontSize: 13,
  },
  panel: {
    background: "#0d1830",
    border: "1px solid #1c2b4f",
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 20,
    marginBottom: 20,
  },
  snapshotBox: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
  },
  th: {
    textAlign: "left",
    padding: "10px 8px",
    borderBottom: "1px solid #23365f",
    fontSize: 13,
    opacity: 0.8,
  },
  td: {
    padding: "10px 8px",
    borderBottom: "1px solid #162544",
    fontSize: 14,
    verticalAlign: "top",
  },
};