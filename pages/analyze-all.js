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

function fmtJson(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function fmtTs(ts) {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString("nl-NL");
  } catch {
    return "-";
  }
}

function scoreColor(score) {
  const s = n(score, 0);
  if (s >= 8) return "#1f7a46";
  if (s >= 6) return "#8a6d1f";
  return "#8a2f2f";
}

function scoreBg(score) {
  const s = n(score, 0);
  if (s >= 8) return "#0d1f17";
  if (s >= 6) return "#20190d";
  return "#221111";
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

function TableBlock({ title, rows, columns }) {
  return (
    <div style={styles.panel}>
      <h3 style={styles.h3}>{title}</h3>

      {title === "Per reden" ? (
        <div style={styles.tableHelp}>
          Hier zie je welke exit-redenen winst of verlies veroorzaken.
        </div>
      ) : null}

      {title === "Per stage" ? (
        <div style={styles.tableHelp}>
          Hier zie je welke funnel-stage gemiddeld het beste werkt.
        </div>
      ) : null}

      {title === "Per entry quality" ? (
        <div style={styles.tableHelp}>
          Hier zie je of hogere entry quality echt beter presteert.
        </div>
      ) : null}

      {title === "Per persistence" ? (
        <div style={styles.tableHelp}>
          Hier zie je of persistence een sterk filter is.
        </div>
      ) : null}

      {title === "Per spread" ? (
        <div style={styles.tableHelp}>
          Hier zie je bij welke spread range de resultaten beter zijn.
        </div>
      ) : null}

      {title === "Per OB score" ? (
        <div style={styles.tableHelp}>
          Hier zie je of orderbook-score echt predictive is.
        </div>
      ) : null}

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
                <td colSpan={columns.length} style={styles.td}>
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

function LessonList({ lessons }) {
  return (
    <div style={styles.panel}>
      <h3 style={styles.h3}>Teacher feedback</h3>

      {!lessons?.length ? (
        <div style={styles.muted}>Geen feedback</div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {lessons.map((item, idx) => (
            <div
              key={idx}
              style={{
                ...styles.lessonItem,
                borderColor:
                  item.type === "good"
                    ? "#1f7a46"
                    : item.type === "improve" || item.type === "warn"
                      ? "#8a2f2f"
                      : "#8a6d1f",
                background:
                  item.type === "good"
                    ? "#0d1f17"
                    : item.type === "improve" || item.type === "warn"
                      ? "#221111"
                      : "#20190d",
              }}
            >
              <div style={styles.lessonType}>{item.type || "note"}</div>
              <div>{item.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupSection({ title, group }) {
  const summary = group?.summary || {};
  const buckets = group?.buckets || {};
  const teacher = group?.teacher || {};
  const liveConfig = group?.liveConfig || null;
  const dataQuality = group?.dataQuality || {};

  const entryCfg = liveConfig?.entry || {};
  const almostCfg = liveConfig?.almost || {};
  const radarCfg = liveConfig?.radar || {};
  const buildupCfg = liveConfig?.buildup || {};

  return (
    <section style={styles.section}>
      <div style={styles.sectionHeader}>
        <h2 style={styles.h2}>{title}</h2>
        <div
          style={{
            ...styles.badge,
            borderColor: scoreColor(teacher?.score),
            background: scoreBg(teacher?.score),
          }}
        >
          Score {n(teacher?.score, 0).toFixed(2)} / 10
        </div>
      </div>

      <div style={styles.grid}>
        <StatCard title="Trades" value={summary.trades || 0} />
        <StatCard title="Wins" value={summary.wins || 0} />
        <StatCard title="Losses" value={summary.losses || 0} />
        <StatCard title="Winrate" value={fmtPct(summary.winRate)} />
        <StatCard title="Total PnL %" value={fmtPct(summary.totalPnlPct)} />
        <StatCard title="Total PnL USD" value={fmtUsd(summary.totalPnlUsd)} />
      </div>

      <div style={styles.grid}>
        <StatCard
          title="Rich trades"
          value={dataQuality.richClosedTrades ?? 0}
          sub="Trades met echte filter snapshot"
        />
        <StatCard
          title="Rich coverage"
          value={fmtPct(dataQuality.richCoveragePct ?? 0)}
          sub="Hoeveel trades bruikbaar zijn voor filter-analyse"
        />
        <StatCard
          title="Avg PnL %"
          value={fmtPct(summary.avgPnlPct)}
          sub="Gemiddelde per trade"
        />
      </div>

      <div style={styles.twoCol}>
        <LessonList lessons={teacher?.lessons || []} />

        <div style={styles.panel}>
          <h3 style={styles.h3}>Live filters / config</h3>

          {liveConfig ? (
            <>
              <div style={styles.configGrid}>
                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Radar volMin</div>
                  <div style={styles.configValue}>{radarCfg?.volMin ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Radar vmMin</div>
                  <div style={styles.configValue}>{radarCfg?.vmMin ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Buildup minVolAcc</div>
                  <div style={styles.configValue}>{buildupCfg?.minVolAcc ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Almost minConfidence</div>
                  <div style={styles.configValue}>{almostCfg?.minConfidence ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Almost maxFlat60Pct</div>
                  <div style={styles.configValue}>{almostCfg?.maxFlat60Pct ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Entry minConfidence</div>
                  <div style={styles.configValue}>{entryCfg?.minConfidence ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Entry spreadMaxPct</div>
                  <div style={styles.configValue}>{entryCfg?.spreadMaxPct ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Entry depthMinUsd1p</div>
                  <div style={styles.configValue}>{entryCfg?.depthMinUsd1p ?? "-"}</div>
                </div>

                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Entry obScoreMin</div>
                  <div style={styles.configValue}>{entryCfg?.obScoreMin ?? "-"}</div>
                </div>
              </div>

              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", opacity: 0.85 }}>
                  Toon volledige live config
                </summary>
                <pre style={styles.pre}>{fmtJson(liveConfig)}</pre>
              </details>
            </>
          ) : (
            <div style={styles.muted}>Geen live config gevonden</div>
          )}
        </div>
      </div>

      <div style={styles.twoCol}>
        <TableBlock
          title="Per reden"
          rows={buckets.byReason || []}
          columns={[
            { key: "key", label: "Reason" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />

        <TableBlock
          title="Per stage"
          rows={buckets.byStage || []}
          columns={[
            { key: "key", label: "Stage" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
            { key: "totalPnlUsd", label: "Totaal USD", render: (r) => fmtUsd(r.totalPnlUsd) },
          ]}
        />
      </div>

      <div style={styles.twoCol}>
        <TableBlock
          title="Per entry quality"
          rows={buckets.byEntryQuality || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />

        <TableBlock
          title="Per persistence"
          rows={buckets.byPersistence || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
      </div>

      <div style={styles.twoCol}>
        <TableBlock
          title="Per spread"
          rows={buckets.bySpread || []}
          columns={[
            { key: "key", label: "Spread bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />

        <TableBlock
          title="Per OB score"
          rows={buckets.byObScore || []}
          columns={[
            { key: "key", label: "OB bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "Winrate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL %", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
      </div>
    </section>
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

  const groups = data?.groups || {};

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

      {loading && <div style={styles.panel}>Laden...</div>}
      {err && <div style={{ ...styles.panel, color: "#ff8b8b" }}>{err}</div>}

      {!loading && !err && data ? (
        <>
          <GroupSection title="Moon Bull" group={groups.moon_bull} />
          <GroupSection title="Moon Bear" group={groups.moon_bear} />
          <GroupSection title="Main Bull" group={groups.main_bull} />
          <GroupSection title="Main Bear" group={groups.main_bear} />
          <GroupSection title="Trade Funnel Totaal" group={groups.trade_funnel} />
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
  section: {
    marginBottom: 28,
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  badge: {
    border: "1px solid #2855a0",
    borderRadius: 999,
    padding: "8px 12px",
    fontSize: 13,
    fontWeight: 700,
  },
  h1: {
    margin: 0,
    fontSize: 34,
    lineHeight: 1.1,
  },
  h2: {
    margin: 0,
    fontSize: 24,
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
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: 20,
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
  lessonItem: {
    background: "#0a1428",
    border: "1px solid #1c2b4f",
    borderRadius: 12,
    padding: 12,
  },
  lessonType: {
    fontSize: 12,
    opacity: 0.7,
    textTransform: "uppercase",
    marginBottom: 6,
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
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 12,
    lineHeight: 1.5,
    background: "#09111f",
    border: "1px solid #1c2b4f",
    borderRadius: 12,
    padding: 12,
    overflowX: "auto",
  },
  tableHelp: {
    fontSize: 13,
    opacity: 0.72,
    marginBottom: 12,
    lineHeight: 1.4,
  },
  configGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
    gap: 12,
  },
  configItem: {
    background: "#09111f",
    border: "1px solid #1c2b4f",
    borderRadius: 12,
    padding: 10,
  },
  configLabel: {
    fontSize: 12,
    opacity: 0.7,
    marginBottom: 6,
  },
  configValue: {
    fontSize: 16,
    fontWeight: 700,
  },
};