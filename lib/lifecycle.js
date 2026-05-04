// lib/lifecycle.js

export function getLifecycleStage(stage, action) {
  const normalizedAction = String(action || "").toUpperCase();
  const normalizedStage = String(stage || "").toLowerCase();

  if (normalizedAction === "ENTRY") return "ENTRY";
  if (normalizedAction === "HOLD") return "HOLD";
  if (normalizedAction === "ADD") return "ADD";
  if (normalizedAction === "PARTIAL_TP") return "PARTIAL";
  if (normalizedAction === "TRAIL") return "TRAILING";
  if (normalizedAction === "MOVE_BE") return "BREAKEVEN";
  if (normalizedAction === "EXIT") return "EXIT";
  if (normalizedAction === "TP") return "EXIT";
  if (normalizedAction === "SL") return "EXIT";
  if (normalizedAction === "WAIT") return "WAIT";
  if (normalizedAction === "REJECT") return "REJECTED";

  if (normalizedStage === "entry") return "RUNNER_HOT_SCAN";
  if (normalizedStage === "almost") return "RUNNER_ALMOST_SCAN";
  if (normalizedStage === "buildup") return "RUNNER_BUILDUP_SCAN";
  if (normalizedStage === "radar") return "RUNNER_RADAR_SCAN";

  return "SCAN";
}

export function isTradeSignal(action) {
  const normalizedAction = String(action || "").toUpperCase();

  return [
    "ENTRY",
    "ADD",
    "PARTIAL_TP",
    "TRAIL",
    "MOVE_BE",
    "EXIT",
    "TP",
    "SL"
  ].includes(normalizedAction);
}

export function isScannerOnly(stage, action) {
  return !isTradeSignal(action) && getLifecycleStage(stage, action).includes("SCAN");
}