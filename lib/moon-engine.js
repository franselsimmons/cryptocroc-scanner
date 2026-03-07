// LEGACY / experimental helper - not used by /api/moon/scan
// Dit bestand wordt niet gebruikt in de productie Moon-flow.
// Het bevat een alternatieve elite-logica die niet aligned is met de huidige pipeline.

const MAX_HISTORY = 3

// =============================
// STATE
// =============================

export function createEmptyState(token) {
  return {
    address: token.address,
    symbol: token.symbol,
    history: [],
    metrics: {}
  }
}

export function updateState(state, snapshot) {
  state.history.push(snapshot)

  if (state.history.length > MAX_HISTORY) {
    state.history.shift()
  }

  return state
}

// =============================
// METRICS
// =============================

function calculateDelta(oldest, latest) {
  const deltaPrice =
    ((latest.price - oldest.price) / oldest.price) * 100

  const deltaVolAcc =
    latest.volAcc - oldest.volAcc

  return { deltaPrice, deltaVolAcc }
}

function detectCompression(history) {
  if (history.length < 3) return false

  const [h1, h2, h3] = history

  return (
    h3.range24 < h2.range24 &&
    h2.range24 < h1.range24
  )
}

function calculateOBSlope(history) {
  if (history.length < 3) return 0

  const [h1, h2, h3] = history

  const slope1 = h2.obScore - h1.obScore
  const slope2 = h3.obScore - h2.obScore

  return (slope1 + slope2) / 2
}

function calculateOBStability(history) {
  if (history.length < 3) return 0

  const scores = history.map(h => h.obScore)
  const mean = scores.reduce((a,b)=>a+b,0) / scores.length

  const variance =
    scores.reduce((a,b)=>a+Math.pow(b-mean,2),0) /
    scores.length

  return Math.sqrt(variance)
}

function estimateATR(history) {
  if (history.length < 2) return 0

  let moves = []

  for (let i = 1; i < history.length; i++) {
    const prev = history[i-1]
    const curr = history[i]

    const pct =
      Math.abs((curr.price - prev.price) / prev.price)

    moves.push(pct)
  }

  return moves.reduce((a,b)=>a+b,0) / moves.length
}

// =============================
// ELITE LOGIC
// =============================

export function evaluateElite(state) {

  const history = state.history

  if (history.length < 3) {
    return { elite: false }
  }

  const oldest = history[0]
  const latest = history[2]

  const { deltaPrice, deltaVolAcc } =
    calculateDelta(oldest, latest)

  const compression =
    detectCompression(history)

  const obSlope =
    calculateOBSlope(history)

  const obStability =
    calculateOBStability(history)

  const atr =
    estimateATR(history)

  state.metrics = {
    deltaPrice,
    deltaVolAcc,
    compression,
    obSlope,
    obStability,
    atr
  }

  // ========= FILTERS =========

  if (deltaPrice > 4) return { elite: false }
  if (deltaVolAcc < 0.15) return { elite: false }
  if (!compression) return { elite: false }

  // 🔧 Aangepaste thresholds (waren 8 en 20, nu realistische waarden)
  if (obSlope < 0.0005) return { elite: false }
  if (obStability > 0.15) return { elite: false }

  const stopLoss =
    latest.price - (latest.price * atr * 1.5)

  const takeProfit =
    latest.price + (latest.price * atr * 3)

  return {
    elite: true,
    stopLoss,
    takeProfit
  }
}