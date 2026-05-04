const el = id => document.getElementById(id);

const STAGES = ["entry", "almost", "buildup", "radar"];

function safeArray(value){
  return Array.isArray(value) ? value : [];
}

function safeNumber(value, fallback = 0){
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function fmtTime(ts){
  const n = Number(ts || 0);

  if(!n){
    return "—";
  }

  try{
    return new Date(n).toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit"
    });
  }catch{
    return "—";
  }
}

function getActions(data){
  if(Array.isArray(data?.trades)) return data.trades;
  if(Array.isArray(data?.tradeSystemResult?.actions)) return data.tradeSystemResult.actions;
  return [];
}

function normalizeFunnelSide(sideData){
  return {
    entry: safeArray(sideData?.entry),
    almost: safeArray(sideData?.almost),
    buildup: safeArray(sideData?.buildup),
    radar: safeArray(sideData?.radar)
  };
}

function countSide(sideData){
  const f = normalizeFunnelSide(sideData);

  return STAGES.reduce((sum, stage) => {
    return sum + safeArray(f[stage]).length;
  }, 0);
}

function countRunnerOutputs(actions){
  return actions.filter(action => {
    const a = String(action?.action || "").toUpperCase();
    return ["ENTRY", "HOLD", "EXIT"].includes(a);
  }).length;
}

function countWaits(actions){
  return actions.filter(action => {
    return String(action?.action || "").toUpperCase() === "WAIT";
  }).length;
}

function setText(id, value){
  const node = el(id);
  if(node) node.innerText = value;
}

async function loadMainDashboard(){
  try{
    const res = await fetch(`/api/public-latest?t=${Date.now()}`, {
      cache: "no-store"
    });

    const data = await res.json();

    const actions = getActions(data);

    const bullCount = safeNumber(data?.bullCount, countSide(data?.funnel?.bull));
    const bearCount = safeNumber(data?.bearCount, countSide(data?.funnel?.bear));

    const runnerOutputs = countRunnerOutputs(actions);
    const waits = countWaits(actions);

    const btcState = data?.btc?.state || "UNKNOWN";
    const btcChg = data?.btc?.chg24 !== undefined
      ? ` ${safeNumber(data.btc.chg24).toFixed(2)}%`
      : "";

    const regime = data?.regime || "UNKNOWN";

    setText("btcState", `${btcState}${btcChg}`);
    setText("regimeState", regime);

    setText("bullCount", bullCount);
    setText("bearCount", bearCount);
    setText("runnerCount", runnerOutputs);
    setText("waitCount", waits);

    const updatedAt =
      data?.updatedAt ||
      data?.storedAt ||
      data?.tradeFunnelUpdatedAt ||
      data?.servedAt ||
      0;

    setText("lastScan", fmtTime(updatedAt));

    const status =
      data?.scanReady === false
        ? "FALLBACK"
        : data?.ok === false
          ? "ERROR"
          : actions.length > 0
            ? "ACTIVE"
            : "IDLE";

    setText("runnerStatus", status);

  }catch(err){
    console.error("MAIN DASHBOARD ERROR:", err);

    setText("btcState", "ERROR");
    setText("regimeState", "ERROR");
    setText("lastScan", "—");
    setText("runnerStatus", "OFFLINE");
  }
}

setInterval(loadMainDashboard, 15000);
loadMainDashboard();