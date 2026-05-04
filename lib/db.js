import fs from "fs";
import path from "path";

const CONNECTION_STRING =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL ||
  process.env.POSTGRES_URL_NON_POOLING ||
  process.env.NEON_DATABASE_URL ||
  "";

let pool = null;
let poolInitTried = false;
let poolAvailable = false;
let ensurePromise = null;

function isVercel() {
  return Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
}

function getJsonFile() {
  if (isVercel()) {
    return path.join("/tmp", "runner_trades.json");
  }

  return path.join(process.cwd(), "data", "runner_trades.json");
}

const JSON_FILE = getJsonFile();

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeString(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function ensureJsonFile() {
  const dir = path.dirname(JSON_FILE);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(JSON_FILE)) {
    fs.writeFileSync(JSON_FILE, JSON.stringify([], null, 2), "utf-8");
  }
}

function readJsonDB() {
  try {
    ensureJsonFile();

    const raw = fs.readFileSync(JSON_FILE, "utf-8");

    if (!raw || !raw.trim()) {
      return [];
    }

    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("RUNNER JSON DB READ ERROR:", e);
    return [];
  }
}

function writeJsonDB(data) {
  try {
    ensureJsonFile();

    const safeData = Array.isArray(data) ? data : [];
    const tempFile = `${JSON_FILE}.tmp`;

    fs.writeFileSync(
      tempFile,
      JSON.stringify(safeData, null, 2),
      "utf-8"
    );

    fs.renameSync(tempFile, JSON_FILE);

    return true;
  } catch (e) {
    console.error("RUNNER JSON DB WRITE ERROR:", e);
    return false;
  }
}

function shouldUseSSL(connectionString) {
  if (!connectionString) return false;

  const lower = String(connectionString).toLowerCase();

  return !(
    lower.includes("localhost") ||
    lower.includes("127.0.0.1")
  );
}

async function getPool() {
  if (pool) return pool;
  if (poolInitTried) return null;

  poolInitTried = true;

  if (!CONNECTION_STRING) return null;

  try {
    const pg = await import("pg");
    const Pool = pg?.Pool;

    if (!Pool) return null;

    pool = new Pool({
      connectionString: CONNECTION_STRING,
      ssl: shouldUseSSL(CONNECTION_STRING)
        ? { rejectUnauthorized: false }
        : false,
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });

    poolAvailable = true;

    return pool;
  } catch (e) {
    console.error("POSTGRES INIT ERROR - runner fallback to JSON:", e?.message || e);
    poolAvailable = false;
    pool = null;
    return null;
  }
}

async function query(text, params = []) {
  const p = await getPool();

  if (!p) {
    throw new Error("POSTGRES_UNAVAILABLE");
  }

  return p.query(text, params);
}

function getModeLabel() {
  if (CONNECTION_STRING && poolAvailable) return "postgres";
  if (CONNECTION_STRING && !poolInitTried) return "postgres_pending";
  if (CONNECTION_STRING && poolInitTried && !poolAvailable) return "json_fallback_pg_missing";

  return "json_fallback";
}

export function getDBMeta() {
  return {
    mode: getModeLabel(),
    profile: "RUNNER",
    hasConnectionString: Boolean(CONNECTION_STRING),
    jsonFile: JSON_FILE
  };
}

async function ensureColumns(tableName, columns) {
  for (const col of columns) {
    await query(`
      ALTER TABLE ${tableName}
      ADD COLUMN IF NOT EXISTS ${col};
    `);
  }
}

export async function ensureDB() {
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const p = await getPool();

    if (!p) {
      ensureJsonFile();
      return;
    }

    await query(`
      CREATE TABLE IF NOT EXISTS closed_trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        result TEXT NOT NULL,
        reason TEXT,
        grade TEXT,
        flow TEXT,
        sniper TEXT,
        entry_type TEXT,
        runner_profile TEXT,
        scanner_quality TEXT,
        ob_bias TEXT,
        regime TEXT,
        btc_state TEXT,
        score DOUBLE PRECISION DEFAULT 0,
        confluence DOUBLE PRECISION DEFAULT 0,
        rr DOUBLE PRECISION DEFAULT 0,
        pnl_pct DOUBLE PRECISION DEFAULT 0,
        entry_price DOUBLE PRECISION DEFAULT 0,
        exit_price DOUBLE PRECISION DEFAULT 0,
        sl DOUBLE PRECISION DEFAULT 0,
        tp DOUBLE PRECISION DEFAULT 0,
        funding DOUBLE PRECISION DEFAULT 0,
        grade_points DOUBLE PRECISION DEFAULT 0,
        recommended_risk TEXT,
        runner_pressure DOUBLE PRECISION DEFAULT 0,
        runner_acceleration DOUBLE PRECISION DEFAULT 0,
        freshness DOUBLE PRECISION DEFAULT 0,
        timestamp_ms BIGINT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_closed_trades_timestamp
      ON closed_trades(timestamp_ms DESC);

      CREATE INDEX IF NOT EXISTS idx_closed_trades_symbol_side
      ON closed_trades(symbol, side);

      CREATE INDEX IF NOT EXISTS idx_closed_trades_entry_type
      ON closed_trades(entry_type);

      CREATE TABLE IF NOT EXISTS system_logs (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT,
        stage TEXT,
        grade TEXT,
        flow TEXT,
        sniper TEXT,
        entry_type TEXT,
        runner_profile TEXT,
        scanner_quality TEXT,
        ob_bias TEXT,
        regime TEXT,
        btc_state TEXT,
        score DOUBLE PRECISION DEFAULT 0,
        confluence DOUBLE PRECISION DEFAULT 0,
        rr DOUBLE PRECISION DEFAULT 0,
        price DOUBLE PRECISION DEFAULT 0,
        entry_price DOUBLE PRECISION DEFAULT 0,
        sl DOUBLE PRECISION DEFAULT 0,
        tp DOUBLE PRECISION DEFAULT 0,
        funding DOUBLE PRECISION DEFAULT 0,
        spread_pct DOUBLE PRECISION DEFAULT 0,
        depth_min_usd_1p DOUBLE PRECISION DEFAULT 0,
        grade_points DOUBLE PRECISION DEFAULT 0,
        recommended_risk TEXT,
        runner_pressure DOUBLE PRECISION DEFAULT 0,
        runner_acceleration DOUBLE PRECISION DEFAULT 0,
        freshness DOUBLE PRECISION DEFAULT 0,
        timestamp_ms BIGINT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp
      ON system_logs(timestamp_ms DESC);

      CREATE INDEX IF NOT EXISTS idx_system_logs_action
      ON system_logs(action);

      CREATE INDEX IF NOT EXISTS idx_system_logs_symbol_side
      ON system_logs(symbol, side);

      CREATE INDEX IF NOT EXISTS idx_system_logs_entry_type
      ON system_logs(entry_type);
    `);

    await ensureColumns("closed_trades", [
      "entry_type TEXT",
      "runner_profile TEXT",
      "scanner_quality TEXT",
      "runner_pressure DOUBLE PRECISION DEFAULT 0",
      "runner_acceleration DOUBLE PRECISION DEFAULT 0",
      "freshness DOUBLE PRECISION DEFAULT 0"
    ]);

    await ensureColumns("system_logs", [
      "entry_type TEXT",
      "runner_profile TEXT",
      "scanner_quality TEXT",
      "runner_pressure DOUBLE PRECISION DEFAULT 0",
      "runner_acceleration DOUBLE PRECISION DEFAULT 0",
      "freshness DOUBLE PRECISION DEFAULT 0"
    ]);
  })();

  return ensurePromise;
}

function normalizeClosedTradeRow(row) {
  return {
    id: safeString(row?.id || `${row?.symbol || "UNKNOWN"}_${row?.side || "NA"}_${row?.timestamp || Date.now()}`),
    symbol: safeString(row?.symbol || "UNKNOWN").toUpperCase(),
    side: safeString(row?.side || "unknown").toLowerCase(),
    result: safeString(row?.result || row?.action || "UNKNOWN").toUpperCase(),
    reason: row?.reason || null,
    grade: row?.grade || null,
    flow: row?.flow || null,
    sniper: row?.sniper || row?.sniperScore || null,
    entryType: row?.entryType || row?.runnerEntryType || row?.sniper || null,
    runnerProfile: row?.runnerProfile || "RUNNER",
    scannerQuality: row?.scannerQuality || null,
    obBias: row?.obBias || row?.ob_bias || null,
    regime: row?.regime || null,
    btcState: row?.btcState || row?.btc_state || null,
    score: safeNumber(row?.score ?? row?.moveScore, 0),
    confluence: safeNumber(row?.confluence, 0),
    rr: safeNumber(row?.rr, 0),
    pnlPct: safeNumber(row?.pnlPct ?? row?.pnl_pct, 0),
    entry: safeNumber(row?.entry ?? row?.entryPrice, 0),
    exit: safeNumber(row?.exit ?? row?.exitPrice, 0),
    sl: safeNumber(row?.sl, 0),
    tp: safeNumber(row?.tp, 0),
    funding: safeNumber(row?.funding, 0),
    gradePoints: safeNumber(row?.gradePoints, 0),
    recommendedRisk: row?.recommendedRisk || null,
    runnerPressure: safeNumber(row?.runnerPressure, 0),
    runnerAcceleration: safeNumber(row?.runnerAcceleration, 0),
    freshness: safeNumber(row?.freshness, 0),
    timestamp: safeNumber(row?.timestamp, Date.now()),
    payload: row
  };
}

function normalizeSystemLogRow(row) {
  return {
    id: safeString(row?.id || `${row?.symbol || "UNKNOWN"}_${row?.action || "LOG"}_${row?.timestamp || Date.now()}`),
    symbol: safeString(row?.symbol || "UNKNOWN").toUpperCase(),
    side: safeString(row?.side || "unknown").toLowerCase(),
    action: safeString(row?.action || "LOG").toUpperCase(),
    reason: row?.reason || null,
    stage: row?.stage || row?.scannerStage || null,
    grade: row?.grade || null,
    flow: row?.flow || null,
    sniper: row?.sniper || row?.sniperScore || null,
    entryType: row?.entryType || row?.runnerEntryType || row?.sniper || null,
    runnerProfile: row?.runnerProfile || "RUNNER",
    scannerQuality: row?.scannerQuality || null,
    obBias: row?.obBias || row?.ob_bias || null,
    regime: row?.regime || null,
    btcState: row?.btcState || row?.btc_state || null,
    score: safeNumber(row?.score ?? row?.moveScore, 0),
    confluence: safeNumber(row?.confluence, 0),
    rr: safeNumber(row?.rr, 0),
    price: safeNumber(row?.price, 0),
    entry: safeNumber(row?.entry ?? row?.entryPrice, 0),
    sl: safeNumber(row?.sl, 0),
    tp: safeNumber(row?.tp, 0),
    funding: safeNumber(row?.funding, 0),
    spreadPct: safeNumber(row?.spreadPct, 0),
    depthMinUsd1p: safeNumber(row?.depthMinUsd1p, 0),
    gradePoints: safeNumber(row?.gradePoints, 0),
    recommendedRisk: row?.recommendedRisk || null,
    runnerPressure: safeNumber(row?.runnerPressure, 0),
    runnerAcceleration: safeNumber(row?.runnerAcceleration, 0),
    freshness: safeNumber(row?.freshness, 0),
    timestamp: safeNumber(row?.timestamp, Date.now()),
    payload: row
  };
}

function buildInsert(columns, rowValues) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(",");
  return {
    columnSql: columns.join(","),
    placeholderSql: placeholders,
    values: rowValues
  };
}

export async function insertClosedTrade(row) {
  await ensureDB();

  const r = normalizeClosedTradeRow(row);

  if (poolAvailable) {
    const columns = [
      "id",
      "symbol",
      "side",
      "result",
      "reason",
      "grade",
      "flow",
      "sniper",
      "entry_type",
      "runner_profile",
      "scanner_quality",
      "ob_bias",
      "regime",
      "btc_state",
      "score",
      "confluence",
      "rr",
      "pnl_pct",
      "entry_price",
      "exit_price",
      "sl",
      "tp",
      "funding",
      "grade_points",
      "recommended_risk",
      "runner_pressure",
      "runner_acceleration",
      "freshness",
      "timestamp_ms",
      "payload"
    ];

    const insert = buildInsert(columns, [
      r.id,
      r.symbol,
      r.side,
      r.result,
      r.reason,
      r.grade,
      r.flow,
      r.sniper,
      r.entryType,
      r.runnerProfile,
      r.scannerQuality,
      r.obBias,
      r.regime,
      r.btcState,
      r.score,
      r.confluence,
      r.rr,
      r.pnlPct,
      r.entry,
      r.exit,
      r.sl,
      r.tp,
      r.funding,
      r.gradePoints,
      r.recommendedRisk,
      r.runnerPressure,
      r.runnerAcceleration,
      r.freshness,
      r.timestamp,
      JSON.stringify(row)
    ]);

    await query(
      `
        INSERT INTO closed_trades (${insert.columnSql})
        VALUES (${insert.placeholderSql})
        ON CONFLICT (id) DO NOTHING
      `,
      insert.values
    );

    return row;
  }

  const db = readJsonDB();
  db.push({ ...row, logType: row?.logType || "TRADE", runnerProfile: row?.runnerProfile || "RUNNER" });
  writeJsonDB(db);

  return row;
}

export async function insertSystemLog(row) {
  await ensureDB();

  const r = normalizeSystemLogRow(row);

  if (poolAvailable) {
    const columns = [
      "id",
      "symbol",
      "side",
      "action",
      "reason",
      "stage",
      "grade",
      "flow",
      "sniper",
      "entry_type",
      "runner_profile",
      "scanner_quality",
      "ob_bias",
      "regime",
      "btc_state",
      "score",
      "confluence",
      "rr",
      "price",
      "entry_price",
      "sl",
      "tp",
      "funding",
      "spread_pct",
      "depth_min_usd_1p",
      "grade_points",
      "recommended_risk",
      "runner_pressure",
      "runner_acceleration",
      "freshness",
      "timestamp_ms",
      "payload"
    ];

    const insert = buildInsert(columns, [
      r.id,
      r.symbol,
      r.side,
      r.action,
      r.reason,
      r.stage,
      r.grade,
      r.flow,
      r.sniper,
      r.entryType,
      r.runnerProfile,
      r.scannerQuality,
      r.obBias,
      r.regime,
      r.btcState,
      r.score,
      r.confluence,
      r.rr,
      r.price,
      r.entry,
      r.sl,
      r.tp,
      r.funding,
      r.spreadPct,
      r.depthMinUsd1p,
      r.gradePoints,
      r.recommendedRisk,
      r.runnerPressure,
      r.runnerAcceleration,
      r.freshness,
      r.timestamp,
      JSON.stringify(row)
    ]);

    await query(
      `
        INSERT INTO system_logs (${insert.columnSql})
        VALUES (${insert.placeholderSql})
        ON CONFLICT (id) DO NOTHING
      `,
      insert.values
    );

    return row;
  }

  const db = readJsonDB();
  db.push({ ...row, logType: row?.logType || "SYSTEM", runnerProfile: row?.runnerProfile || "RUNNER" });
  writeJsonDB(db);

  return row;
}

export async function getClosedTrades(limit = null) {
  await ensureDB();

  if (poolAvailable) {
    if (limit && Number(limit) > 0) {
      const { rows } = await query(
        `
          SELECT payload
          FROM closed_trades
          ORDER BY timestamp_ms ASC
          LIMIT $1
        `,
        [Number(limit)]
      );

      return rows.map(r => r.payload);
    }

    const { rows } = await query(`
      SELECT payload
      FROM closed_trades
      ORDER BY timestamp_ms ASC
    `);

    return rows.map(r => r.payload);
  }

  const db = readJsonDB().filter(row => row?.logType === "TRADE");

  if (limit && Number(limit) > 0) {
    return db.slice(0, Number(limit));
  }

  return db;
}

export async function getSystemLogs(limit = null) {
  await ensureDB();

  if (poolAvailable) {
    if (limit && Number(limit) > 0) {
      const { rows } = await query(
        `
          SELECT payload
          FROM system_logs
          ORDER BY timestamp_ms ASC
          LIMIT $1
        `,
        [Number(limit)]
      );

      return rows.map(r => r.payload);
    }

    const { rows } = await query(`
      SELECT payload
      FROM system_logs
      ORDER BY timestamp_ms ASC
    `);

    return rows.map(r => r.payload);
  }

  const db = readJsonDB().filter(row => row?.logType === "SYSTEM");

  if (limit && Number(limit) > 0) {
    return db.slice(0, Number(limit));
  }

  return db;
}

export async function getAllLogs(limit = null) {
  await ensureDB();

  if (poolAvailable) {
    const [trades, system] = await Promise.all([
      getClosedTrades(limit),
      getSystemLogs(limit)
    ]);

    return [...trades, ...system].sort((a, b) => {
      return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
    });
  }

  const db = readJsonDB();

  const sorted = [...db].sort((a, b) => {
    return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
  });

  if (limit && Number(limit) > 0) {
    return sorted.slice(0, Number(limit));
  }

  return sorted;
}

export async function pruneClosedTrades(maxRows) {
  await ensureDB();

  const limit = Number(maxRows || 0);

  if (limit <= 0) return;

  if (poolAvailable) {
    await query(
      `
        DELETE FROM closed_trades
        WHERE id IN (
          SELECT id
          FROM (
            SELECT id
            FROM closed_trades
            ORDER BY timestamp_ms DESC
            OFFSET $1
          ) x
        )
      `,
      [limit]
    );

    return;
  }

  const db = readJsonDB();
  const trades = db.filter(row => row?.logType === "TRADE");
  const system = db.filter(row => row?.logType === "SYSTEM");

  while (trades.length > limit) {
    trades.shift();
  }

  writeJsonDB([...trades, ...system].sort((a, b) => {
    return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
  }));
}

export async function pruneSystemLogs(maxRows) {
  await ensureDB();

  const limit = Number(maxRows || 0);

  if (limit <= 0) return;

  if (poolAvailable) {
    await query(
      `
        DELETE FROM system_logs
        WHERE id IN (
          SELECT id
          FROM (
            SELECT id
            FROM system_logs
            ORDER BY timestamp_ms DESC
            OFFSET $1
          ) x
        )
      `,
      [limit]
    );

    return;
  }

  const db = readJsonDB();
  const trades = db.filter(row => row?.logType === "TRADE");
  const system = db.filter(row => row?.logType === "SYSTEM");

  while (system.length > limit) {
    system.shift();
  }

  writeJsonDB([...trades, ...system].sort((a, b) => {
    return Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
  }));
}

export async function clearClosedTrades() {
  await ensureDB();

  if (poolAvailable) {
    await query(`DELETE FROM closed_trades`);
    return;
  }

  const db = readJsonDB().filter(row => row?.logType !== "TRADE");
  writeJsonDB(db);
}

export async function clearSystemLogs() {
  await ensureDB();

  if (poolAvailable) {
    await query(`DELETE FROM system_logs`);
    return;
  }

  const db = readJsonDB().filter(row => row?.logType !== "SYSTEM");
  writeJsonDB(db);
}

export async function clearAllLogs() {
  await ensureDB();

  if (poolAvailable) {
    await query(`
      DELETE FROM closed_trades;
      DELETE FROM system_logs;
    `);
    return;
  }

  writeJsonDB([]);
}

// ================= COMPAT SHIMS =================
export async function readDB() {
  return getAllLogs();
}

export async function writeDB(data) {
  await clearAllLogs();

  const list = Array.isArray(data) ? data : [];

  for (const row of list) {
    if (row?.logType === "SYSTEM") {
      await insertSystemLog(row);
      continue;
    }

    await insertClosedTrade(row);
  }

  return true;
}