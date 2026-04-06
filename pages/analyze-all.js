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

function Panel({ title, children }) {
  return (
    <div style={styles.panel}>
      <h2 style={styles.h2}>{title}</h2>
      {children}
    </div>
  );
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

function GroupBlock({ title, group }) {
  const summary = group?.summary || {};
  const buckets = group?.buckets || {};
  const teacher = group?.teacher || {};
  const liveConfig = group?.liveConfig || null;

  return (
    <div style={{ marginBottom: 28 }}>
      <Panel title={title}>
        <div style={styles.grid}>
          <StatCard title="Trades" value={summary.trades || 0} />
          <StatCard title="Winrate" value={fmtPct(summary.winRate)} />
          <StatCard title="Avg PnL %" value={fmtPct(summary.avgPnlPct)} />
          <StatCard title="Total PnL %" value={fmtPct(summary.totalPnlPct)} />
          <StatCard title="Total PnL USD" value={fmtUsd(summary.totalPnlUsd)} />
          <StatCard title="Teacher score" value={`${n(teacher.score, 0).toFixed(1)}/10`} />
        </div>

        <div style={styles.twoCol}>
          <div>
            <h3 style={styles.h3}>Teacher feedback</h3>
            <div style={styles.lessonList}>
              {(teacher.lessons || []).length ? (
                teacher.lessons.map((x, i) => (
                  <div key={i} style={styles.lessonItem}>
                    <strong>{x.type?.toUpperCase() || "TIP"}:</strong> {x.text}
                  </div>
                ))
              ) : (
                <div style={styles.muted}>Nog geen feedback</div>
              )}
            </div>
          </div>

          <div>
            <h3 style={styles.h3}>Live config snapshot</h3>
            <pre style={styles.pre}>
              {JSON.stringify(liveConfig, null, 2)}
            </pre>
          </div>
        </div>
      </Panel>

      <div style={styles.twoCol}>
        <SimpleTable
          title={`${title} - By reason`}
          rows={buckets.byReason || []}
          columns={[
            { key: "key", label: "Reason" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />

        <SimpleTable
          title={`${title} - By stage`}
          rows={buckets.byStage || []}
          columns={[
            { key: "key", label: "Stage" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />
      </div>

      <div style={styles.twoCol}>
        <SimpleTable
          title={`${title} - Entry quality buckets`}
          rows={buckets.byEntryQuality || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />

        <SimpleTable
          title={`${title} - Persistence buckets`}
          rows={buckets.byPersistence || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
      </div>

      <div style={styles.twoCol}>
        <SimpleTable
          title={`${title} - Spread buckets`}
          rows={buckets.bySpread || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />

        <SimpleTable
          title={`${title} - OB score buckets`}
          rows={buckets.byObScore || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
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

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.h1}>Analyze All</h1>
          <div style={styles.muted}>Live teacher-analyse per funnel en per mode</div>
        </div>
        <button onClick={load} style={styles.button}>Refresh</button>
      </div>

      {loading ? <div style={styles.panel}>Laden...</div> : null}
      {err ? <div style={{ ...styles.panel, color: "#ff8b8b" }}>{err}</div> : null}

      {!loading && !err && data ? (
        <>
          <GroupBlock title="Moon Bull" group={data?.groups?.moon_bull} />
          <GroupBlock title="Moon Bear" group={data?.groups?.moon_bear} />
          <GroupBlock title="Main Bull" group={data?.groups?.main_bull} />
          <GroupBlock title="Main Bear" group={data?.groups?.main_bear} />
          <GroupBlock title="Trade Funnel" group={data?.groups?.trade_funnel} />
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
  pre: {
    background: "#08111f",
    border: "1px solid #1c2b4f",
    borderRadius: 12,
    padding: 12,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 12,
    lineHeight: 1.45,
    overflowX: "auto",
  },
  lessonList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  lessonItem: {
    background: "#101d37",
    border: "1px solid #20345c",
    borderRadius: 12,
    padding: 12,
  },
};