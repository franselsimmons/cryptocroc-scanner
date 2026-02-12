export function percentile(sortedArr, p) {
  // sortedArr moet gesorteerd zijn
  if (!sortedArr.length) return 0;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  const w = idx - lo;
  return sortedArr[lo] * (1 - w) + sortedArr[hi] * w;
}

export function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}
