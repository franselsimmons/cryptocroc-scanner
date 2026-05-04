// lib/scanStore.js
// RUNNER SCAN STORE
// Doel:
// - /api/cron of /api/scanner?notify=true&store=true schrijft latest runner scan
// - /api/public-latest leest alleen latest runner scan
// - KV/Upstash houdt latest scan + stage memory vast tussen Vercel cold starts

const STORE_KEY = "runnerTradeSystem:latestScan:v1";
const STAGE_MEMORY_KEY = "runnerTradeSystem:stageMemory:v1";

const globalStore = globalThis.__RUNNER_TRADE_SYSTEM_SCAN_STORE__ || {
  latestScan: null,
  stageMemory: {},
  lastRedisReadAt: 0,
  lastStageMemoryReadAt: 0
};

globalThis.__RUNNER_TRADE_SYSTEM_SCAN_STORE__ = globalStore;

// ================= CONFIG =================
const MEMORY_CACHE_TTL_MS = 15 * 1000;

// ================= KV / UPSTASH CONFIG =================
function getRedisUrl() {
  return (
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    ""
  );
}

function getRedisToken() {
  return (
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    ""
  );
}

function hasRedis() {
  return Boolean(getRedisUrl() && getRedisToken());
}

// ================= SAFE JSON =================
function safeJsonParse(value, fallback = null) {
  if (value === undefined || value === null) return fallback;

  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function isPlainObject(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function normalizeLatestScan(data) {
  if (!isPlainObject(data)) return null;
  if (!data.ok) return null;

  return {
    ...data,
    scannerProfile: data.scannerProfile || "RUNNER",
    restoredAt: Date.now()
  };
}

function normalizeStageMemory(memory) {
  if (!isPlainObject(memory)) return {};

  const out = {};

  for (const [key, value] of Object.entries(memory)) {
    if (!key || !isPlainObject(value)) continue;

    out[key] = {
      stage: typeof value.stage === "string" ? value.stage : "radar",
      prevStage: typeof value.prevStage === "string" ? value.prevStage : "radar",

      entryType: typeof value.entryType === "string" ? value.entryType : null,
      score: Number.isFinite(Number(value.score)) ? Number(value.score) : 0,

      updatedAt: Number(value.updatedAt || value.ts || Date.now())
    };
  }

  return out;
}

// ================= REDIS COMMAND =================
async function redisCommand(command) {
  const url = getRedisUrl();
  const token = getRedisToken();

  if (!url || !token) {
    throw new Error("Redis env missing");
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });

  const json = await res.json().catch(() => null);

  if (!res.ok || json?.error) {
    throw new Error(json?.error || `Redis error ${res.status}`);
  }

  return json?.result;
}

// ================= LATEST SCAN =================
export async function setLatestScan(data) {
  const payload = {
    ...(data || {}),
    ok: data?.ok !== false,
    scannerProfile: data?.scannerProfile || "RUNNER",
    storedAt: Date.now()
  };

  globalStore.latestScan = payload;

  if (hasRedis()) {
    try {
      await redisCommand([
        "SET",
        STORE_KEY,
        JSON.stringify(payload)
      ]);
    } catch (e) {
      console.error("RUNNER SCAN STORE SET ERROR:", e.message);
    }
  }

  return payload;
}

export async function getLatestScan() {
  const now = Date.now();

  if (
    globalStore.latestScan &&
    now - Number(globalStore.lastRedisReadAt || 0) < MEMORY_CACHE_TTL_MS
  ) {
    return globalStore.latestScan;
  }

  if (hasRedis()) {
    try {
      const result = await redisCommand(["GET", STORE_KEY]);
      const parsed = safeJsonParse(result, null);
      const normalized = normalizeLatestScan(parsed);

      if (normalized) {
        globalStore.latestScan = normalized;
        globalStore.lastRedisReadAt = now;
        return normalized;
      }
    } catch (e) {
      console.error("RUNNER SCAN STORE GET ERROR:", e.message);
    }
  }

  return globalStore.latestScan;
}

export async function clearLatestScan() {
  globalStore.latestScan = null;
  globalStore.lastRedisReadAt = 0;

  if (hasRedis()) {
    try {
      await redisCommand(["DEL", STORE_KEY]);
    } catch (e) {
      console.error("RUNNER SCAN STORE CLEAR ERROR:", e.message);
    }
  }

  return {
    ok: true,
    profile: "RUNNER",
    clearedAt: Date.now()
  };
}

// ================= STAGE MEMORY =================
export function getStageMemory() {
  return globalStore.stageMemory || {};
}

export function setStageMemory(newMemory) {
  const normalized = normalizeStageMemory(newMemory || {});

  globalStore.stageMemory = normalized;
  globalStore.lastStageMemoryReadAt = Date.now();

  if (hasRedis()) {
    void redisCommand([
      "SET",
      STAGE_MEMORY_KEY,
      JSON.stringify(normalized)
    ]).catch(e => {
      console.error("RUNNER STAGE MEMORY SET ERROR:", e.message);
    });
  }

  return globalStore.stageMemory;
}

export function clearStageMemory() {
  globalStore.stageMemory = {};
  globalStore.lastStageMemoryReadAt = 0;

  if (hasRedis()) {
    void redisCommand(["DEL", STAGE_MEMORY_KEY]).catch(e => {
      console.error("RUNNER STAGE MEMORY CLEAR ERROR:", e.message);
    });
  }

  return {
    ok: true,
    profile: "RUNNER",
    clearedAt: Date.now()
  };
}

// ================= ASYNC STAGE MEMORY =================
export async function loadStageMemoryFromStore() {
  const now = Date.now();

  if (
    globalStore.stageMemory &&
    Object.keys(globalStore.stageMemory).length > 0 &&
    now - Number(globalStore.lastStageMemoryReadAt || 0) < MEMORY_CACHE_TTL_MS
  ) {
    return globalStore.stageMemory;
  }

  if (hasRedis()) {
    try {
      const result = await redisCommand(["GET", STAGE_MEMORY_KEY]);
      const parsed = safeJsonParse(result, {});
      const normalized = normalizeStageMemory(parsed);

      globalStore.stageMemory = normalized;
      globalStore.lastStageMemoryReadAt = now;

      return normalized;
    } catch (e) {
      console.error("RUNNER STAGE MEMORY GET ERROR:", e.message);
    }
  }

  return globalStore.stageMemory || {};
}

export async function saveStageMemoryToStore(newMemory) {
  const normalized = normalizeStageMemory(newMemory || {});

  globalStore.stageMemory = normalized;
  globalStore.lastStageMemoryReadAt = Date.now();

  if (hasRedis()) {
    try {
      await redisCommand([
        "SET",
        STAGE_MEMORY_KEY,
        JSON.stringify(normalized)
      ]);
    } catch (e) {
      console.error("RUNNER STAGE MEMORY SAVE ERROR:", e.message);
    }
  }

  return normalized;
}

export function getScanStoreMeta() {
  return {
    profile: "RUNNER",
    latestScanCached: Boolean(globalStore.latestScan),
    stageMemoryKeys: Object.keys(globalStore.stageMemory || {}).length,
    hasRedis: hasRedis(),
    storeKey: STORE_KEY,
    stageMemoryKey: STAGE_MEMORY_KEY,
    servedAt: Date.now()
  };
}