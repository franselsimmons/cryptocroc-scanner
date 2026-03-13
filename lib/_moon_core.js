import { kv } from "@vercel/kv";

// ---------- Runtime config ----------
export const RUNTIME_CONFIG = {
  runtime: "nodejs",
};

// ======================================================
// MOON V2 CONFIG (voor moon-scan)
// ======================================================
export const MOON_V2 = {
  bull: {
    minVol24h: 350_000,
    minVmRadar: 0.08,
    minVmBuildup: 0.18,
    minVmAlmost: 0.24,
    minVmElite: 0.30,

    minCh1hRadar: -0.8,
    minCh1hBuildup: 0.6,
    minCh1hAlmost: 1.2,
    minCh1hIgnition: 1.35,
    minCh1hExpansion: 3.2,

    minCh24Radar: 1.5,
    minCh24Buildup: 4,
    minCh24Almost: 8,
    minCh24Ignition: 8,
    minCh24Expansion: 18,

    minObBull: 0.025,
    minObStrong: 0.040,
    spreadMaxRadar: 1.40,
    spreadMaxElite: 1.05,

    maxExhaust24: 85,
    minVelocity: 0.10,
    strongVelocity: 0.13,
    explosiveVelocity: 0.22,

    maxMcapRadar: 600_000_000,
    maxMcapBuildup: 350_000_000,
    maxMcapAlmost: 250_000_000,
    maxMcapElite: 180_000_000,
  },

  bear: {
    minVol24h: 350_000,
    minVmRadar: 0.08,
    minVmBuildup: 0.18,
    minVmAlmost: 0.24,
    minVmElite: 0.30,

    maxCh1hRadar: 0.8,
    maxCh1hBuildup: -0.6,
    maxCh1hAlmost: -1.2,
    maxCh1hIgnition: -1.35,
    maxCh1hCascade: -3.2,

    maxCh24Radar: -1.5,
    maxCh24Buildup: