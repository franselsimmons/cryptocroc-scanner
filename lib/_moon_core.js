// lib/_moon_core.js

export function normalizeVolAcc(volHistory) {
  if (!volHistory || volHistory.length < 2) return 0

  const first = volHistory[0]
  const last = volHistory[volHistory.length - 1]

  if (first === 0) return 0

  return (last - first) / first
}

export function calculateOBScore(bidDepth, askDepth) {
  if (!bidDepth || !askDepth) return 0

  const total = bidDepth + askDepth
  if (total === 0) return 0

  return (bidDepth / total) * 100
}