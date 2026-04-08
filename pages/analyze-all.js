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

function toneFromScore(score) {
  const s = n(score, 0);
  if (s >= 8) return { border: "#1f7a46", bg: "#0d1f17" };
  if (s >= 6) return { border: "#8a6d1f", bg: "#20190d" };
  return { border: "#8a2f2f", bg: "#221111" };
}

// Helper om de beste bucket te vinden voor de top-weergave
function getBestBucketStr(buckets) {
  if (!Array.isArray(buckets) || !buckets.length) return "-";
  const valid = buckets.filter(b => n(b.count, 0) >= 3); // Minimaal 3 trades voor relevantie
  if (!valid.length) return "-";
  const best = valid.sort((a, b) => n(b.avgPnlPct, 0) - n(a.avgPnlPct, 0))[0];
  return `${best.key} (${fmtPct(best.avgPnlPct)})`;
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

function ActionCenterCard({ title, overviewItem, group }) {
  const tone = toneFromScore(overviewItem?.score);
  const buckets = group?.buckets || {};

  return (
    <div style={{ ...styles.topCard, borderColor: tone.border, background: tone.bg }}>
      <div style={styles.topCardHead}>
        <div style={styles.topCardName}>{title}</div>
        <div style={styles.topCardScore}>Score {n(overviewItem?.score, 0).toFixed(2)}</div>
      </div>

      <div style={styles.topCardAction}>
        {overviewItem?.topAdjustment?.title || "Geen harde actie vereist"}
      </div>

      <div style={styles.topCardText}>
        {overviewItem?.topAdjustment?.shortText || "Monitor de huidige waarden, er is nog geen duidelijke richting voor aanpassing."}
      </div>

      <div style={styles.bestFiltersGrid}>
        <div style={styles.bestFilterItem}>
          <span style={styles.bestFilterLabel}>Beste Entry Q.</span>
          <span style={styles.bestFilterValue}>{getBestBucketStr(buckets.byEntryQuality)}</span>
        </div>
        <div style={styles.bestFilterItem}>
          <span style={styles.bestFilterLabel}>Beste Spread</span>
          <span style={styles.bestFilterValue}>{getBestBucketStr(buckets.bySpread)}</span>
        </div>
        <div style={styles.bestFilterItem}>
          <span style={styles.bestFilterLabel}>Beste OB Score</span>
          <span style={styles.bestFilterValue}>{getBestBucketStr(buckets.byObScore)}</span>
        </div>
        <div style={styles.bestFilterItem}>
          <span style={styles.bestFilterLabel}>Beste Persist.</span>
          <span style={styles.bestFilterValue}>{getBestBucketStr(buckets.byPersistence)}</span>
        </div>
      </div>

      <div style={styles.topCardMeta}>
        Trades {n(overviewItem?.trades, 0)} • Winrate {fmtPct(overviewItem?.winRate)} • Avg {fmtPct(overviewItem?.avgPnlPct)}
      </div>
    </div>
  );
}

// ... [Behoud TableBlock, LessonList, ActionPlan, GroupSection exact zoals ze waren in je originele code] ...

// Voor beknoptheid hier weggelaten, kopieer deze vanuit je originele React bestand.
function TableBlock({ title, rows, columns }) { /* Originele code */ return null; }
function LessonList({ lessons, title }) { /* Originele code */ return null; }
function ActionPlan({ group }) { /* Originele code */ return null; }
function GroupSection({ title, group }) { /* Originele code */ return null; }

export default function AnalyzeAllPage() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      setLoading(true);
      setErr("");
      const res = await fetch("/api/analyze-all", { cache: "no-store" });
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
  const overview = data?.overview || {};

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.h1}>Analyze All Dashboard</h1>
          <div style={styles.muted}>Laatste refresh: {fmtTs(data?.ts)}</div>
        </div>
        <button onClick={load} style={styles.button}>Refresh</button>
      </div>

      {loading && <div style={styles.panel}>Laden...</div>}
      {err && <div style={{ ...styles.panel, color: "#ff8b8b" }}>{err}</div>}

      {!loading && !err && data ? (
        <>
          <section style={styles.section}>
            <h2 style={styles.h2}>🚀 Actiecentrum: Direct aanpassen & Beste filters</h2>
            <div style={styles.topGrid}>
              <ActionCenterCard title="Trade Funnel Totaal" overviewItem={overview.trade_funnel} group={groups.trade_funnel} />
              <ActionCenterCard title="Moon Bull" overviewItem={overview.moon_bull} group={groups.moon_bull} />
              <ActionCenterCard title="Moon Bear" overviewItem={overview.moon_bear} group={groups.moon_bear} />
              <ActionCenterCard title="Main Bull" overviewItem={overview.main_bull} group={groups.main_bull} />
              <ActionCenterCard title="Main Bear" overviewItem={overview.main_bear} group={groups.main_bear} />
            </div>
          </section>

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
  // ... [Behoud je originele styles] ...
  page: { minHeight: "100vh", background: "#08111f", color: "#f4f7fb", padding: 24, fontFamily: "Inter, Arial, sans-serif" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 24 },
  section: { marginBottom: 28 },
  h1: { margin: 0, fontSize: 34, lineHeight: 1.1 },
  h2: { margin: "0 0 14px 0", fontSize: 24 },
  muted: { opacity: 0.75, marginTop: 6 },
  button: { background: "#12305f", color: "#fff", border: "1px solid #2855a0", borderRadius: 12, padding: "10px 16px", cursor: "pointer" },
  panel: { background: "#0d1830", border: "1px solid #1c2b4f", borderRadius: 18, padding: 18, marginBottom: 20 },
  topGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 14, marginBottom: 18 },
  topCard: { border: "1px solid #1c2b4f", borderRadius: 16, padding: 16, display: "flex", flexDirection: "column" },
  topCardHead: { display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 12 },
  topCardName: { fontSize: 16, fontWeight: 700 },
  topCardScore: { fontSize: 13, opacity: 0.8 },
  topCardAction: { fontSize: 17, fontWeight: 700, marginBottom: 8, color: "#fff" },
  topCardText: { fontSize: 13, lineHeight: 1.5, opacity: 0.85, marginBottom: 16, flexGrow: 1 },
  topCardMeta: { fontSize: 12, opacity: 0.72, marginTop: 16, borderTop: "1px solid rgba(255,255,255,0.1)", paddingTop: 10 },
  
  // Nieuwe stijlen voor de best filters grid in de top card
  bestFiltersGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, background: "rgba(0,0,0,0.2)", padding: 10, borderRadius: 8 },
  bestFilterItem: { display: "flex", flexDirection: "column", fontSize: 12 },
  bestFilterLabel: { opacity: 0.6, fontSize: 11, textTransform: "uppercase", marginBottom: 2 },
  bestFilterValue: { fontWeight: 600, color: "#a5c2f5" }
};
