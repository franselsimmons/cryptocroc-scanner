// pages/analyze-all.js
import { useEffect, useMemo, useState } from "react";

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

function safeArray(v) {
  return Array.isArray(v) ? v : [];
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

function Badge({ children, tone = "default" }) {
  const toneStyle =
    tone === "good"
      ? styles.badgeGood
      : tone === "warn"
        ? styles.badgeWarn
        : tone === "bad"
          ? styles.badgeBad
          : styles.badge;

  return <span style={{ ...styles.badge, ...toneStyle }}>{children}</span>;
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
                <th key={col.key} style={styles.th}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {safeArray(rows).map((row, idx) => (
              <tr key={`${title}-${idx}`}>
                {columns.map((col) => (
                  <td key={col.key} style={styles.td}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
            {!safeArray(rows).length ? (
              <tr>
                <td style={styles.td} colSpan={columns.length}>
                  Geen data
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LessonList({ teacher }) {
  const lessons = safeArray(teacher?.lessons);

  return (
    <div style={styles.panel}>
      <h3 style={styles.h3}>Teacher feedback</h3>

      <div style={{ marginBottom: 14 }}>
        <span style={styles.scoreBox}>
          Score: {n(teacher?.score, 0).toFixed(2)} / 10
        </span>
      </div>

      {!lessons.length ? (
        <div style={styles.muted}>Nog geen feedback beschikbaar.</div>
      ) : (
        <div style={styles.lessonList}>
          {lessons.map((item, idx) => {
            const type = String(item?.type || "focus").toLowerCase();
            const tone =
              type === "good"
                ? "good"
                : type === "improve"
                  ? "bad"
                  : type === "focus"
                    ? "warn"
                    : "default";

            return (
              <div key={`lesson-${idx}`} style={styles.lessonItem}>
                <div style={{ marginBottom: 6 }}>
                  <Badge tone={tone}>{type}</Badge>
                </div>
                <div>{item?.text || "-"}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BucketTables({ buckets }) {
  return (
    <>
      <div style={styles.twoCol}>
        <SimpleTable
          title="Per exit reason"
          rows={buckets?.byReason || []}
          columns={[
            { key: "key", label: "Reason" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />

        <SimpleTable
          title="Per stage"
          rows={buckets?.byStage || []}
          columns={[
            { key: "key", label: "Stage" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />
      </div>

      <div style={styles.twoCol}>
        <SimpleTable
          title="Per entry quality bucket"
          rows={buckets?.byEntryQuality || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />

        <SimpleTable
          title="Per persistence bucket"
          rows={buckets?.byPersistence || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />
      </div>

      <div style={styles.twoCol}>
        <SimpleTable
          title="Per spread bucket"
          rows={buckets?.bySpread || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />

        <SimpleTable
          title="Per orderbook score bucket"
          rows={buckets?.byObScore || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Win rate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Avg PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Total USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />
      </div>
    </>
  );
}

function GroupSection({ title, group }) {
  const summary = group?.summary || {};
  const teacher = group?.teacher || {};
  const buckets = group?.buckets || {};
  const liveConfig = group?.liveConfig || null;

  return (
    <section style={styles.section}>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.h2}>{title}</h2>
          <div style={styles.muted}>
            Analyse van deze volledige funnel als groep, niet per coin.
          </div>
        </div>
      </div>

      <div style={styles.grid}>
        <StatCard title="Trades" value={summary.trades || 0} />
        <StatCard title="Wins" value={summary.wins || 0} />
        <StatCard title="Losses" value={summary.losses || 0} />
        <StatCard title="Win rate" value={fmtPct(summary.winRate)} />
        <StatCard title="Total PnL %" value={fmtPct(summary.totalPnlPct)} />
        <StatCard title="Total PnL USD" value={fmtUsd(summary.totalPnlUsd)} />
        <StatCard title="Avg PnL %" value={fmtPct(summary.avgPnlPct)} />
        <StatCard title="Teacher score" value={n(teacher.score, 0).toFixed(2)} sub="/ 10" />
      </div>

      <div style={styles.twoCol}>
        <LessonList teacher={teacher} />

        <div style={styles.panel}>
          <h3 style={styles.h3}>Live config snapshot</h3>
          {!liveConfig ? (
            <div style={styles.muted}>Geen live config ontvangen voor deze groep.</div>
          ) : (
            <pre style={styles.pre}>{JSON.stringify(liveConfig, null, 2)}</pre>
          )}
        </div>
      </div>

      <BucketTables buckets={buckets} />
    </section>
  );
}

export default function AnalyzeAllPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("moon_bull");

  async function load() {
    try {
      setLoading(true);
      setErr("");

      const res = await fetch("/api/analyze-all");
      const json = await res.json();

      if (!json?.ok) {
        throw new Error(json?.error || "Load failed");
      }

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

  const groups = data?.groups || {};

  const tabs = useMemo(
    () => [
      { key: "moon_bull", label: "Moon Bull" },
      { key: "moon_bear", label: "Moon Bear" },
      { key: "main_bull", label: "Main Bull" },
      { key: "main_bear", label: "Main Bear" },
      { key: "trade_funnel", label: "Trade Funnel" },
    ],
    []
  );

  const activeGroup = groups?.[activeTab] || null;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.h1}>Analyze All</h1>
          <div style={styles.muted}>Laatste refresh: {fmtTs(data?.ts)}</div>
          <div style={styles.muted}>
            Deze pagina leest live uit <code>/api/analyze-all</code>.
          </div>
        </div>

        <button onClick={load} style={styles.button}>
          Refresh
        </button>
      </div>

      {loading ? <div style={styles.panel}>Laden...</div> : null}
      {err ? <div style={{ ...styles.panel, color: "#ff8b8b" }}>{err}</div> : null}

      {!loading && !err && data ? (
        <>
          <div style={styles.panel}>
            <h2 style={styles.h2}>Kies groep</h2>
            <div style={styles.tabRow}>
              {tabs.map((tab) => {
                const isActive = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    style={{
                      ...styles.tabButton,
                      ...(isActive ? styles.tabButtonActive : {}),
                    }}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
          </div>

          {activeGroup ? (
            <GroupSection
              title={tabs.find((x) => x.key === activeTab)?.label || activeTab}
              group={activeGroup}
            />
          ) : (
            <div style={styles.panel}>Geen data gevonden voor deze groep.</div>
          )}
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
  section: {
    marginBottom: 24,
  },
  panel: {
    background: "#0d1830",
    border: "1px solid #1c2b4f",
    borderRadius: 18,
    padding: 18,
    marginBottom: 20,
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
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 20,
    marginBottom: 20,
  },
  sectionHeader: {
    marginBottom: 8,
  },
  lessonList: {
    display: "grid",
    gap: 10,
  },
  lessonItem: {
    border: "1px solid #1c2b4f",
    borderRadius: 12,
    padding: 12,
    background: "#0a1427",
  },
  badge: {
    display: "inline-block",
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid #38507d",
    background: "#13213d",
    color: "#dce8ff",
    textTransform: "uppercase",
  },
  badgeGood: {
    border: "1px solid #2f7d4a",
    background: "#10311c",
    color: "#9ef0b3",
  },
  badgeWarn: {
    border: "1px solid #8a6a2a",
    background: "#31240d",
    color: "#ffd98e",
  },
  badgeBad: {
    border: "1px solid #8a2a2a",
    background: "#341111",
    color: "#ffaaaa",
  },
  scoreBox: {
    display: "inline-block",
    padding: "8px 12px",
    borderRadius: 12,
    background: "#13213d",
    border: "1px solid #2a4c8c",
    fontWeight: 700,
  },
  pre: {
    background: "#08111f",
    padding: 12,
    borderRadius: 12,
    border: "1px solid #1c2b4f",
    overflowX: "auto",
    fontSize: 12,
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
  },
  tabRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
  },
  tabButton: {
    background: "#10203b",
    color: "#dfe8ff",
    border: "1px solid #274777",
    borderRadius: 12,
    padding: "10px 14px",
    cursor: "pointer",
  },
  tabButtonActive: {
    background: "#183766",
    border: "1px solid #4c84d9",
  },
};