export default async function handler(req, res) {
  try {
    const secret = req.query?.secret;
    if (secret !== "lara-roos") {
      return res.status(401).json({ ok: false });
    }

    const BASE = process.env.BASE_URL || "";

    async function safeFetch(url) {
      try {
        const r = await fetch(url);
        return await r.json();
      } catch (e) {
        return null;
      }
    }

    const main = await safeFetch(`${BASE}/api/analyze-main?secret=${secret}`);
    const moonBull = await safeFetch(`${BASE}/api/moon?mode=bull&secret=${secret}`);
    const moonBear = await safeFetch(`${BASE}/api/moon?mode=bear&secret=${secret}`);
    const trade = await safeFetch(`${BASE}/api/trade?secret=${secret}`);

    function scoreField(v, min, good) {
      if (v >= good) return 9;
      if (v >= min) return 6;
      return 3;
    }

    function analyze(list = []) {
      return list.map(c => {
        const quality = scoreField(c.qualityScore || 0, 60, 75);
        const liquidity = scoreField(c.liquidityScore || 0, 55, 70);
        const timing = scoreField(c.timingScore || 0, 55, 70);
        const market = scoreField(c.marketScore || 0, 40, 60);

        const score = Math.round((quality + liquidity + timing + market) / 4);

        const bottlenecks = [];
        const advice = [];

        if (quality < 7) {
          bottlenecks.push("kwaliteit");
          advice.push("Wacht op betere setup (entryQuality omhoog)");
        }

        if (liquidity < 7) {
          bottlenecks.push("liquiditeit");
          advice.push("Focus op coins met betere depth/spread");
        }

        if (timing < 7) {
          bottlenecks.push("timing");
          advice.push("Wacht op breakout + volume confirmatie");
        }

        if (market < 7) {
          bottlenecks.push("markt");
          advice.push("Trade alleen met BTC richting");
        }

        return {
          symbol: c.symbol,
          stage: c.stage,
          score,
          bottlenecks,
          advice,
        };
      }).filter(c => c.score < 8);
    }

    res.status(200).json({
      ok: true,
      main: {
        problems: analyze(main?.candidates?.premium || []),
      },
      moon: {
        bull: {
          problems: analyze(moonBull?.candidates?.premium || []),
        },
        bear: {
          problems: analyze(moonBear?.candidates?.premium || []),
        },
      },
      trade: {
        problems: analyze(trade?.candidates?.premium || []),
      },
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
}