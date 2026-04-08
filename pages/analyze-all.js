import { useEffect, useState } from "react";

function n(x, d = 0) {
  const v = Number(x);
  return Number.isFinite(v) ? v : d;
}

function fmtPct(v) {
  return `${n(v, 0).toFixed(2)}%`;
}

function fmtUsd(v) {
  return `$${n(v, 0).toFixed(0)}`; // Geen decimalen voor USD scheelt ruimte op mobiel
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
    return new Date(ts).toLocaleString("nl-NL", { 
      hour: '2-digit', minute:'2-digit', day: '2-digit', month: '2-digit' 
    });
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

// ---- COMPONENT: Duidelijke Actiekaart ----
function TopActionCard({ adjustment, groupName = "" }) {
  if (!adjustment) return null;

  let bgColor = "#0d1830";
  let borderColor = "#1c2b4f";
  let icon = "💡";

  if (adjustment.type === "config_change") {
    bgColor = "#102414"; 
    borderColor = "#2c5e2e";
    icon = "🚀";
  } else if (adjustment.type === "risk_problem" || adjustment.type === "timeout_problem") {
    bgColor = "#2b1414"; 
    borderColor = "#732424";
    icon = "⚠️";
  } else if (adjustment.type === "monitor" || adjustment.type === "sample_small") {
    bgColor = "#14171c"; 
    borderColor = "#2a2f38";
    icon = "🔍";
  }

  return (
    <div className="action-card" style={{ background: bgColor, borderColor: borderColor }}>
      <div className="action-header">
        <span style={{ fontSize: 22 }}>{icon}</span>
        <h3 className="action-title">
          {groupName ? `${groupName.replace("_", " ").toUpperCase()}: ` : ""}
          {adjustment.title}
        </h3>
      </div>
      <p className="action-text">
        {adjustment.longText || adjustment.shortText}
      </p>
    </div>
  );
}

// ---- COMPONENT: Global Overview bovenaan de pagina ----
function GlobalActionBoard({ overview }) {
  if (!overview) return null;

  const actionableGroups = Object.keys(overview)
    .map((key) => ({ key, data: overview[key] }))
    .filter(
      (g) =>
        g.data?.topAdjustment?.type === "config_change" ||
        g.data?.topAdjustment?.type === "risk_problem" ||
        g.data?.topAdjustment?.type === "timeout_problem"
    )
    .sort((a, b) => n(b.data?.topAdjustment?.priority) - n(a.data?.topAdjustment?.priority));

  if (!actionableGroups.length) {
    return (
      <div className="panel" style={{ borderColor: "#1f7a46" }}>
        <h2 className="h2" style={{ color: "#4ae88d", marginBottom: 8 }}>✅ Alles staat stabiel</h2>
        <div className="muted">
          Er zijn op dit moment geen harde configuratiewijzigingen of risico-ingrepen nodig.
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ borderColor: "#732424", background: "#1a0b0b" }}>
      <h2 className="h2" style={{ color: "#ff8b8b", marginBottom: 16 }}>⚡ Directe Acties Vereist</h2>
      <div className="grid-1-col">
        {actionableGroups.map((g) => (
          <TopActionCard key={g.key} groupName={g.key} adjustment={g.data.topAdjustment} />
        ))}
      </div>
    </div>
  );
}

function StatCard({ title, value, sub }) {
  return (
    <div className="stat-card">
      <div className="stat-title">{title}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

function TableBlock({ title, rows, columns, helpText }) {
  return (
    <div className="panel">
      <h3 className="h3">{title}</h3>
      {helpText && <div className="table-help">{helpText}</div>}
      
      <div className="table-scroll-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key}>{col.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows || []).map((row, idx) => (
              <tr key={`${title}-${idx}`}>
                {columns.map((col) => (
                  <td key={col.key}>
                    {col.render ? col.render(row) : row[col.key]}
                  </td>
                ))}
              </tr>
            ))}
            {!rows?.length ? (
              <tr>
                <td colSpan={columns.length} style={{ textAlign: "center" }}>
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

function LessonList({ lessons, title = "Teacher feedback" }) {
  return (
    <div className="panel">
      <h3 className="h3">{title}</h3>

      {!lessons?.length ? (
        <div className="muted">Geen feedback</div>
      ) : (
        <div className="lesson-grid">
          {lessons.map((item, idx) => (
            <div
              key={idx}
              className="lesson-item"
              style={{
                borderColor:
                  item.type === "good" ? "#1f7a46"
                    : item.type === "improve" || item.type === "warn" || item.type === "blocker" ? "#8a2f2f"
                    : "#8a6d1f",
                background:
                  item.type === "good" ? "#0d1f17"
                    : item.type === "improve" || item.type === "warn" || item.type === "blocker" ? "#221111"
                    : "#20190d",
              }}
            >
              <div className="lesson-type">{item.type || "note"}</div>
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
    <section className="group-section">
      <div className="section-header">
        <h2 className="h2">{title}</h2>
        <div className="score-badge" style={{ borderColor: scoreColor(teacher?.score), background: scoreBg(teacher?.score) }}>
          Score {n(teacher?.score, 0).toFixed(1)}/10
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <TopActionCard adjustment={topAdjustment} />
      </div>

      <div className="grid-2-col">
        <StatCard title="Trades" value={summary.trades || 0} />
        <StatCard title="Winrate" value={fmtPct(summary.winRate)} />
        <StatCard title="Avg PnL" value={fmtPct(summary.avgPnlPct)} />
        <StatCard title="Total PnL" value={fmtUsd(summary.totalPnlUsd)} />
        <StatCard title="Rich coverage" value={fmtPct(dataQuality.richCoveragePct ?? 0)} sub="Data kwaliteit" />
      </div>

      <div className="grid-2-col-large">
        <LessonList lessons={teacher?.lessons || []} title="Belangrijkste lessen" />

        <div className="panel">
          <h3 className="h3">Live filters / config</h3>
          {liveConfig ? (
            <>
              <div className="config-grid">
                <div className="config-item"><div className="config-label">Radar volMin</div><div className="config-value">{radarCfg?.volMin ?? "-"}</div></div>
                <div className="config-item"><div className="config-label">Radar vmMin</div><div className="config-value">{radarCfg?.vmMin ?? "-"}</div></div>
                <div className="config-item"><div className="config-label">Almost minConf</div><div className="config-value">{almostCfg?.minConfidence ?? "-"}</div></div>
                <div className="config-item"><div className="config-label">Entry minConf</div><div className="config-value">{entryCfg?.minConfidence ?? "-"}</div></div>
                <div className="config-item"><div className="config-label">Entry spreadMax</div><div className="config-value">{entryCfg?.spreadMaxPct ?? "-"}</div></div>
                <div className="config-item"><div className="config-label">Entry obScore</div><div className="config-value">{entryCfg?.obScoreMin ?? "-"}</div></div>
              </div>
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", opacity: 0.85, fontSize: 13 }}>Toon volledige JSON config</summary>
                <pre className="pre-box">{fmtJson(liveConfig)}</pre>
              </details>
            </>
          ) : (
            <div className="muted">Geen live config gevonden</div>
          )}
        </div>
      </div>

      <div className="grid-2-col-large">
        <TableBlock
          title="Waar sterke coins blijven hangen"
          helpText="Funnel-stages waar coins vaak vastzitten terwijl ze later sterk blijken."
          rows={funnelBlockers.stuckStats || []}
          columns={[
            { key: "stage", label: "Stage", render: (r) => r.group ? `${r.group}/${r.stage}` : r.stage },
            { key: "seenCoins", label: "Gezien" },
            { key: "laterStrongCoins", label: "Later Sterk" },
            { key: "rate", label: "Rate", render: (r) => fmtPct(r.stuckButLaterStrongRate) },
          ]}
        />
        <LessonList lessons={funnelBlockers?.lessons || []} title="Funnel blocker lessen" />
      </div>

      <div className="grid-2-col-large">
        <TableBlock
          title="Per exit reden"
          rows={buckets.byReason || []}
          columns={[
            { key: "key", label: "Reden" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "WinRate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
        <TableBlock
          title="Per stage"
          rows={buckets.byStage || []}
          columns={[
            { key: "key", label: "Stage" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "WinRate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
      </div>

      <div className="grid-2-col-large">
        <TableBlock
          title="Per entry quality"
          rows={buckets.byEntryQuality || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "WinRate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
        <TableBlock
          title="Per persistence"
          rows={buckets.byPersistence || []}
          columns={[
            { key: "key", label: "Bucket" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "WinRate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
      </div>
      
      <div className="grid-2-col-large">
        <TableBlock
          title="Per spread"
          rows={buckets.bySpread || []}
          columns={[
            { key: "key", label: "Spread" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "WinRate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL", render: (r) => fmtPct(r.avgPnlPct) },
          ]}
        />
        <TableBlock
          title="Per OB score"
          rows={buckets.byObScore || []}
          columns={[
            { key: "key", label: "OB Score" },
            { key: "count", label: "Trades" },
            { key: "winRate", label: "WinRate", render: (r) => fmtPct(r.winRate) },
            { key: "avgPnlPct", label: "Gem. PnL", render: (r) => fmtPct(r.avgPnlPct) },
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
    <div className="page-container">
      {/* INJECTEER CSS VOOR MOBIELE RESPONSIVENESS */}
      <style dangerouslySetInnerHTML={{__html: `
        :root {
          --bg-dark: #050b14;
          --bg-panel: #0a1326;
          --border: #162544;
          --text-main: #f4f7fb;
          --text-muted: #8da9dc;
        }
        body { margin: 0; background: var(--bg-dark); color: var(--text-main); font-family: Inter, system-ui, sans-serif; }
        * { box-sizing: border-box; }
        
        .page-container { padding: 24px; max-width: 1200px; margin: 0 auto; }
        .page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
        .h1 { margin: 0; font-size: 28px; line-height: 1.2; }
        .h2 { margin: 0; font-size: 22px; }
        .h3 { margin: 0 0 12px 0; font-size: 16px; color: var(--text-muted); }
        .muted { opacity: 0.7; font-size: 13px; margin-top: 4px; }
        
        .refresh-btn { background: #12305f; color: #fff; border: 1px solid #2855a0; border-radius: 8px; padding: 10px 16px; font-weight: 600; cursor: pointer; }
        .refresh-btn:active { background: #0c2040; }

        .panel { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
        .group-section { margin-bottom: 40px; padding-top: 24px; border-top: 1px solid var(--border); }
        .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
        .score-badge { border: 1px solid; border-radius: 99px; padding: 6px 12px; font-size: 13px; font-weight: bold; white-space: nowrap; }

        /* Grids */
        .grid-1-col { display: grid; gap: 12px; }
        .grid-2-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 16px; }
        .grid-2-col-large { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px; }

        /* Stat Cards */
        .stat-card { background: #060d1a; border: 1px solid var(--border); border-radius: 10px; padding: 12px; }
        .stat-title { opacity: 0.7; font-size: 12px; margin-bottom: 6px; }
        .stat-value { font-size: 20px; font-weight: bold; }
        .stat-sub { opacity: 0.6; font-size: 11px; margin-top: 4px; }

        /* Action Cards */
        .action-card { border: 1px solid; border-radius: 12px; padding: 16px; }
        .action-header { display: flex; align-items: center; gap: 10px; }
        .action-title { margin: 0; font-size: 16px; color: #fff; }
        .action-text { margin: 8px 0 0 0; font-size: 13px; opacity: 0.9; line-height: 1.5; }

        /* Tables (Scrollable op mobiel) */
        .table-scroll-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; margin: 0 -16px; padding: 0 16px; }
        .data-table { width: 100%; border-collapse: collapse; min-width: 280px; }
        .data-table th { text-align: left; padding: 8px; border-bottom: 1px solid #1c2b4f; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
        .data-table td { padding: 10px 8px; border-bottom: 1px solid #111e36; font-size: 13px; white-space: nowrap; }
        .table-help { font-size: 12px; opacity: 0.7; margin-bottom: 12px; line-height: 1.4; }

        /* Lessons */
        .lesson-grid { display: grid; gap: 8px; }
        .lesson-item { border: 1px solid; border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.4; }
        .lesson-type { font-size: 10px; opacity: 0.7; text-transform: uppercase; margin-bottom: 4px; font-weight: bold; }

        /* Config */
        .config-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; }
        .config-item { background: #060d1a; border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
        .config-label { font-size: 10px; opacity: 0.7; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .config-value { font-size: 14px; font-weight: bold; }
        .pre-box { background: #050b14; border: 1px solid var(--border); border-radius: 8px; padding: 10px; font-size: 11px; overflow-x: auto; }

        /* Mobiele optimalisaties */
        @media (max-width: 600px) {
          .page-container { padding: 16px; }
          .grid-2-col-large { grid-template-columns: 1fr; }
          .stat-value { font-size: 18px; }
          .panel { padding: 14px; }
        }
      `}} />

      <div className="page-header">
        <div>
          <h1 className="h1">System Analyze</h1>
          <div className="muted">Refresh: {fmtTs(data?.ts)}</div>
        </div>
        <button onClick={load} className="refresh-btn">
          Herlaad
        </button>
      </div>

      {loading && <div className="panel">Laden van data en berekenen van optimalisaties...</div>}
      {err && <div className="panel" style={{ color: "#ff8b8b" }}>{err}</div>}

      {!loading && !err && data ? (
        <>
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
