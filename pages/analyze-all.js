// Pages/analyze-all.js (of waar je frontend staat)
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

// ---- NIEUWE COMPONENT: Duidelijke Actiekaart ----
function TopActionCard({ adjustment, groupName = "" }) {
  if (!adjustment) return null;

  let bgColor = "#0d1830";
  let borderColor = "#1c2b4f";
  let icon = "💡";

  if (adjustment.type === "config_change") {
    bgColor = "#102414"; // Donkergroen
    borderColor = "#2c5e2e";
    icon = "🚀";
  } else if (adjustment.type === "risk_problem" || adjustment.type === "timeout_problem") {
    bgColor = "#2b1414"; // Donkerrood
    borderColor = "#732424";
    icon = "⚠️";
  } else if (adjustment.type === "monitor" || adjustment.type === "sample_small") {
    bgColor = "#14171c"; // Neutraal grijs
    borderColor = "#2a2f38";
    icon = "🔍";
  }

  return (
    <div style={{ ...styles.actionCard, background: bgColor, borderColor: borderColor }}>
      <div style={styles.actionHeader}>
        <span style={{ fontSize: 22 }}>{icon}</span>
        <h3 style={{ margin: 0, fontSize: 17, color: "#fff" }}>
          {groupName ? `${groupName.replace("_", " ").toUpperCase()}: ` : ""}
          {adjustment.title}
        </h3>
      </div>
      <p style={{ marginTop: 10, marginBottom: 0, fontSize: 14, opacity: 0.9, lineHeight: 1.5 }}>
        {adjustment.longText || adjustment.shortText}
      </p>
    </div>
  );
}

// ---- NIEUWE COMPONENT: Global Overview bovenaan de pagina ----
function GlobalActionBoard({ overview }) {
  if (!overview) return null;

  // Haal alleen de groepen op die ECHT actie vereisen (geen monitor of te klein sample)
  const actionableGroups = Object.keys(overview)
    .map((key) => ({ key, data: overview[key] }))
    .filter(
      (g) =>
        g.data?.topAdjustment?.type === "config_change" ||
        g.data?.topAdjustment?.type === "risk_problem" ||
        g.data?.topAdjustment?.type === "timeout_problem"
    )
    .sort((a, b) => n(b.data?.topAdjustment?.priority) - n(a.data?.topAdjustment?.priority)); // Belangrijkste eerst

  if (!actionableGroups.length) {
    return (
      <div style={{ ...styles.panel, borderColor: "#1f7a46" }}>
        <h2 style={{ ...styles.h2, color: "#4ae88d", marginBottom: 8 }}>✅ Alles staat stabiel</h2>
        <div style={styles.muted}>
          Er zijn op dit moment geen harde configuratiewijzigingen of risico-ingrepen nodig op basis van de huidige data.
        </div>
      </div>
    );
  }

  return (
    <div style={{ ...styles.panel, borderColor: "#732424", background: "#1a0b0b" }}>
      <h2 style={{ ...styles.h2, color: "#ff8b8b", marginBottom: 16 }}>⚡ Directe Acties Vereist</h2>
      <div style={styles.twoCol}>
        {actionableGroups.map((g) => (
          <TopActionCard key={g.key} groupName={g.key} adjustment={g.data.topAdjustment} />
        ))}
      </div>
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

function TableBlock({ title, rows, columns }) {
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
                    : item.type === "improve" || item.type === "warn" || item.type === "blocker"
                      ? "#8a2f2f"
                      : "#8a6d1f",
                background:
                  item.type === "good"
                    ? "#0d1f17"
                    : item.type === "improve" || item.type === "warn" || item.type === "blocker"
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
  const funnelBlockers = group?.funnelBlockers || {};
  const topAdjustment = group?.topAdjustment || null;

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

      {/* ACTIEKAART DIRECT ONDER DE TITEL */}
      <div style={{ marginBottom: 20 }}>
        <TopActionCard adjustment={topAdjustment} />
      </div>

      <div style={styles.grid}>
        <StatCard title="Trades" value={summary.trades || 0} />
        <StatCard title="Winrate" value={fmtPct(summary.winRate)} />
        <StatCard title="Avg PnL %" value={fmtPct(summary.avgPnlPct)} sub="Gemiddelde per trade" />
        <StatCard title="Total PnL USD" value={fmtUsd(summary.totalPnlUsd)} />
        <StatCard
          title="Rich coverage"
          value={fmtPct(dataQuality.richCoveragePct ?? 0)}
          sub="Bruikbaar voor filter-analyse"
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
                  <div style={styles.configLabel}>Almost minConf</div>
                  <div style={styles.configValue}>{almostCfg?.minConfidence ?? "-"}</div>
                </div>
                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Entry minConf</div>
                  <div style={styles.configValue}>{entryCfg?.minConfidence ?? "-"}</div>
                </div>
                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Entry spreadMax</div>
                  <div style={styles.configValue}>{entryCfg?.spreadMaxPct ?? "-"}</div>
                </div>
                <div style={styles.configItem}>
                  <div style={styles.configLabel}>Entry obScoreMin</div>
                  <div style={styles.configValue}>{entryCfg?.obScoreMin ?? "-"}</div>
                </div>
              </div>
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", opacity: 0.85 }}>Toon volledige live config</summary>
                <pre style={styles.pre}>{fmtJson(liveConfig)}</pre>
              </details>
            </>
          ) : (
            <div style={styles.muted}>Geen live config gevonden</div>
          )}
        </div>
      </div>

      <div style={styles.twoCol}>
        <div style={styles.panel}>
          <h3 style={styles.h3}>Waar sterke coins blijven hangen</h3>
          <div style={styles.tableHelp}>
            Dit laat zien in welke funnel-stage coins vaak vastzitten terwijl ze later alsnog sterk blijken.
          </div>
          {!funnelBlockers?.stuckStats?.length ? (
            <div style={styles.muted}>Nog geen funnel blocker data</div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={styles.table}>
                <thead>
                  <tr>
                    <th style={styles.th}>Stage</th>
                    <th style={styles.th}>Gezien</th>
                    <th style={styles.th}>Later sterk</th>
                    <th style={styles.th}>Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {funnelBlockers.stuckStats.map((row, idx) => (
                    <tr key={`stuck-${idx}`}>
                      <td style={styles.td}>{row.group ? `${row.group} / ${row.stage}` : row.stage}</td>
                      <td style={styles.td}>{row.seenCoins}</td>
                      <td style={styles.td}>{row.laterStrongCoins}</td>
                      <td style={styles.td}>{fmtPct(row.stuckButLaterStrongRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <TableBlock
          title="Per reden"
          rows={buckets.byReason || []}
          columns={[
            { key: "key", label: "Reason" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "WinRate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem PnL", render: (r) => fmtPct(r.avgPnlPct) },
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
            { key: "avgPnlPct", label: "Gem PnL", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
        <TableBlock
          title="Per spread"
          rows={buckets.bySpread || []}
          columns={[
            { key: "key", label: "Spread" },
            { key: "count", label: "Trades" },
            { key: "avgPnlPct", label: "Gem PnL", render: (r) => fmtPct(r.avgPnlPct) },
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
  const overview = data?.overview || null;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.h1}>System Analyze</h1>
          <div style={styles.muted}>Laatste refresh: {fmtTs(data?.ts)}</div>
        </div>
        <button onClick={load} style={styles.button}>
          Refresh Data
        </button>
      </div>

      {loading && <div style={styles.panel}>Laden van data en berekenen van optimalisaties...</div>}
      {err && <div style={{ ...styles.panel, color: "#ff8b8b" }}>{err}</div>}

      {!loading && !err && data ? (
        <>
          {/* NIEUW: Direct de belangrijkste acties in beeld */}
          <GlobalActionBoard overview={overview} />

          <GroupSection title="Trade Funnel Totaal" group={groups.trade_funnel} />
          <GroupSection title="Moon Bull" group={groups.moon_bull} />
          <GroupSection title="Moon Bear" group={groups.moon_bear} />
          <GroupSection title="Main Bull" group={groups.main_bull} />
          <GroupSection title="Main Bear" group={groups.main_bear} />
        </>
      ) : null}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#050b14",
    color: "#f4f7fb",
    padding: 24,
    fontFamily: "Inter, Arial, sans-serif",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 16,
    marginBottom: 32,
  },
  section: {
    marginBottom: 40,
    paddingTop: 24,
    borderTop: "1px solid #162544",
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 16,
  },
  badge: {
    border: "1px solid #2855a0",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 13,
    fontWeight: 700,
  },
  h1: { margin: 0, fontSize: 32, lineHeight: 1.1 },
  h2: { margin: 0, fontSize: 24 },
  h3: { margin: "0 0 12px 0", fontSize: 16, color: "#a5c2f5" },
  muted: { opacity: 0.65, marginTop: 6, fontSize: 14 },
  button: {
    background: "#12305f",
    color: "#fff",
    border: "1px solid #2855a0",
    borderRadius: 8,
    padding: "10px 18px",
    cursor: "pointer",
    fontWeight: 600,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 16,
    marginBottom: 20,
  },
  twoCol: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
    gap: 16,
    marginBottom: 20,
  },
  card: {
    background: "#0a1326",
    border: "1px solid #162544",
    borderRadius: 12,
    padding: 16,
  },
  cardTitle: { opacity: 0.7, fontSize: 13, marginBottom: 8 },
  cardValue: { fontSize: 24, fontWeight: 700 },
  cardSub: { opacity: 0.6, marginTop: 6, fontSize: 12 },
  panel: {
    background: "#0a1326",
    border: "1px solid #162544",
    borderRadius: 12,
    padding: 20,
    marginBottom: 16,
  },
  actionCard: {
    border: "1px solid",
    borderRadius: 12,
    padding: 16,
  },
  actionHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
  },
  lessonItem: {
    background: "#060d1a",
    border: "1px solid #162544",
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    lineHeight: 1.5,
  },
  lessonType: { fontSize: 11, opacity: 0.6, textTransform: "uppercase", marginBottom: 6, fontWeight: 600 },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "10px 8px", borderBottom: "1px solid #1c2b4f", fontSize: 13, color: "#8da9dc" },
  td: { padding: "10px 8px", borderBottom: "1px solid #111e36", fontSize: 14, verticalAlign: "top" },
  pre: {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    fontSize: 12,
    lineHeight: 1.5,
    background: "#050b14",
    border: "1px solid #162544",
    borderRadius: 8,
    padding: 12,
    overflowX: "auto",
  },
  tableHelp: { fontSize: 13, opacity: 0.6, marginBottom: 12, lineHeight: 1.4 },
  configGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8 },
  configItem: { background: "#060d1a", border: "1px solid #162544", borderRadius: 8, padding: 10 },
  configLabel: { fontSize: 11, opacity: 0.6, marginBottom: 4 },
  configValue: { fontSize: 15, fontWeight: 600 },
};
