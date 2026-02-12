import { redis } from "../lib/kv.js";
import { percentile, clamp } from "../lib/math.js";
import { timingScore, calcDerived, nextStage } from "../lib/funnel.js";

function now() { return Date.now(); }

function pickCtl(side, ch24, rangePct) {
  // ctl is “close-to-(low/high)” proxy; we hebben alleen CG data, dus simpele proxy:
  // bij bull: hogere ch24 + lagere range => hogere ctl
  // bij bear: lagere ch24 + lagere range => lagere ctl
  const base = clamp(0.5 + (ch24 / 100) * 0.8, 0, 1);
  const rangePenalty = clamp(1 - (rangePct * 2), 0, 1);
  const ctl = clamp(base * 0.7 + rangePenalty * 0.3, 0, 1);
  return side === "BULL" ? ctl : 1 - ctl;
}

export default async function handler(req, res) {
  try {
    const started = now();

    // 1) CoinGecko markets (top 250 genoeg)
    const cgUrl =
      "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h";

    const cg = await fetch(cgUrl).then(r => r.json());
    if (!Array.isArray(cg)) return res.status(200).json({ ok: false, error: "CoinGecko invalid response" });

    // 2) Poolfilters
    const pool = cg.filter(c => {
      const mcap = c.market_cap || 0;
      const vol = c.total_volume || 0;
      const vm = mcap > 0 ? vol / mcap : 0;
      return (
        mcap >= 3_000_000 &&
        mcap <= 400_000_000 &&
        vol >= 250_000 &&
        vm >= 0.10
      );
    });

    // 3) Dynamische bands (10e/90e percentiel) op ch24
    const chArr = pool
      .map(c => Number(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? 0))
      .filter(n => Number.isFinite(n))
      .sort((a,b)=>a-b);

    const lowBand = percentile(chArr, 0.10);
    const highBand = percentile(chArr, 0.90);

    // 4) Side bepalen + memory per side
    const out = {
      ENTRY: [],
      ALMOST: [],
      BUILDUP: [],
      RADAR: []
    };

    // we beperken scan load
    const candidates = pool.slice(0, 120);

    for (const c of candidates) {
      const symbol = (c.symbol || "").toUpperCase();
      if (!symbol) continue;

      const ch24 = Number(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? 0) || 0;
      const mcap = Number(c.market_cap || 0);
      const vol = Number(c.total_volume || 0);
      const vm = mcap > 0 ? vol / mcap : 0;

      // rangePct: CG heeft geen high/low in markets response altijd; we schatten met abs(ch24)
      const rangePct = clamp(Math.abs(ch24) / 100, 0, 1);

      let side = null;
      if (ch24 >= highBand) side = "BULL";
      if (ch24 <= lowBand) side = "BEAR";
      if (!side) continue;

      const passSide = true;

      const ctl = pickCtl(side, ch24, rangePct);
      const timing = timingScore({ side, ch24, vm, rangePct, ctl });

      const memKey = `mem:${side}:${symbol}`;
      const stateKey = `state:${side}:${symbol}`;

      const hist = (await redis.get(memKey)) || [];
      const prevState = (await redis.get(stateKey)) || { stage: "RADAR", scansInStage: 0 };

      const entry = {
        ts: now(),
        price: Number(c.current_price || 0),
        vol,
        vm,
        ch24,
        passSide
      };

      hist.push(entry);
      if (hist.length > 30) hist.shift();
      await redis.set(memKey, hist);

      const { totalScans, consistency, volAcc, flatness } = calcDerived(hist);

      const stageWanted = nextStage({
        totalScans,
        scansInStage: prevState.scansInStage,
        consistency,
        volAcc,
        flatness,
        timing
      });

      // scansInStage bijhouden (als stage gelijk blijft -> +1, anders reset)
      const newState = {
        stage: stageWanted,
        scansInStage: prevState.stage === stageWanted ? (prevState.scansInStage + 1) : 1,
        totalScans
      };
      await redis.set(stateKey, newState);

      // Output coin item
      out[stageWanted].push({
        symbol,
        name: c.name,
        side,
        stage: stageWanted,
        price: entry.price,
        ch24,
        mcap,
        vol,
        vm,
        timing,
        consistency,
        volAcc,
        flatness,
        // voor orderbook in UI:
        obSymbol: `${symbol}USDT`
      });
    }

    // sort: ENTRY boven, per stage op timing/vol/consistency
    const sortFn = (a,b) =>
      (b.timing - a.timing) ||
      (b.consistency - a.consistency) ||
      (b.vol - a.vol);

    out.ENTRY.sort(sortFn);
    out.ALMOST.sort(sortFn);
    out.BUILDUP.sort(sortFn);
    out.RADAR.sort(sortFn);

    return res.status(200).json({
      ok: true,
      meta: {
        scanned: candidates.length,
        pool: pool.length,
        lowBand,
        highBand,
        ms: now() - started
      },
      funnel: out
    });

  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
