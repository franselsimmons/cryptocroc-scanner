// Shared helpers for MAIN (non-moon) endpoints.
// MAIN bull en MAIN bear importeren hier alleen gedeelde infra/helpers vandaan.

export {
  RUNTIME_CONFIG,
  requireSecret,

  // data sources
  fetchBTCGateFromUniverse,
  fetchCoinGeckoTopCached,
  getBitgetSpotUsdtSymbols,

  // KV keys / portfolio / state helpers
  keyMainLatest,
  keyMainState,
  keyMainPortfolio,
  keyMainPositions,
} from "./_moon_core.js";