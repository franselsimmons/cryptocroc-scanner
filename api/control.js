const SYSTEM_PROFILE = "RUNNER";

const DEFAULT_STATE = {
  profile: SYSTEM_PROFILE,
  mode: "both",
  scanSide: "both",
  runnerEnabled: true,
  notify: true,
  store: true,
  updatedAt: Date.now()
};

function getControlState() {
  if (!globalThis.__RUNNER_CONTROL_STATE__) {
    globalThis.__RUNNER_CONTROL_STATE__ = { ...DEFAULT_STATE };
  }

  return globalThis.__RUNNER_CONTROL_STATE__;
}

function normalizeMode(value, fallback = "both") {
  const v = String(value || "").toLowerCase().trim();

  if (v === "bull") return "bull";
  if (v === "bear") return "bear";
  if (v === "both") return "both";
  if (v === "auto") return "auto";

  return fallback;
}

function normalizeBool(value, fallback = true) {
  if (value === undefined || value === null) return fallback;

  const v = String(value || "").toLowerCase().trim();

  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;

  return fallback;
}

export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");

  const state = getControlState();

  if (req.method === "GET") {
    const requestedMode = req?.query?.mode;

    if (requestedMode !== undefined) {
      const mode = normalizeMode(requestedMode, state.mode);

      globalThis.__RUNNER_CONTROL_STATE__ = {
        ...state,
        mode,
        scanSide: mode === "auto" ? "both" : mode,
        updatedAt: Date.now()
      };
    }

    return res.status(200).json({
      ok: true,
      ...getControlState()
    });
  }

  if (req.method === "POST") {
    const body = req.body || {};

    const mode = normalizeMode(body.mode ?? req?.query?.mode, state.mode);
    const notify = normalizeBool(body.notify ?? req?.query?.notify, state.notify);
    const store = normalizeBool(body.store ?? req?.query?.store, state.store);
    const runnerEnabled = normalizeBool(
      body.runnerEnabled ?? req?.query?.runnerEnabled,
      state.runnerEnabled
    );

    globalThis.__RUNNER_CONTROL_STATE__ = {
      ...state,
      profile: SYSTEM_PROFILE,
      mode,
      scanSide: mode === "auto" ? "both" : mode,
      runnerEnabled,
      notify,
      store,
      updatedAt: Date.now()
    };

    return res.status(200).json({
      ok: true,
      ...getControlState()
    });
  }

  return res.status(405).json({
    ok: false,
    error: "method_not_allowed"
  });
}