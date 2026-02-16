// OB result (vervang jouw obView blok hiermee)
const obRaw = await kv.get(keyMoonObResult(mode, sym));
const obView = obRaw
  ? {
      valid: !!obRaw.valid,
      stale: !!obRaw.stale,
      score: Number(obRaw?.score ?? obRaw?.ob?.score ?? obRaw?.avgScore ?? 0),
      spreadPct: Number(obRaw?.spreadPct ?? obRaw?.ob?.spreadPct ?? 999),
      lor: Number(obRaw?.lor ?? obRaw?.ob?.lor ?? 1),
      agree: Number(obRaw?.agree ?? 0),
      bidUsd: Number(obRaw?.ob?.bidUsd ?? 0),
      askUsd: Number(obRaw?.ob?.askUsd ?? 0),
      reason: obRaw?.reason || "",
    }
  : null;