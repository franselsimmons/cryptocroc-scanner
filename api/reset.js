import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    const secret = req.query.secret;
    if (secret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // 1) Alles verwijderen wat scanner-data kan vasthouden
    // (pas key-namen aan als jij andere gebruikt)
    const KEYS = [
      // output / latest
      "LATEST_BULL",
      "LATEST_BEAR",
      "LATEST_META",

      // funnel state
      "BULL_STATE",
      "BEAR_STATE",

      // orderbook samples / caches
      "OB_SAMPLES",
      "OB_CACHE",

      // btc gate cache
      "BTC_STATE",
      "BTC_CACHE",

      // risk engine / portfolio
      "PORTFOLIO_STATE",
      "RISK_STATE",

      // locks / cron
      "CRON_LOCK"
    ];

    // delete vaste keys
    await Promise.all(KEYS.map((k) => kv.del(k)));

    // 2) Alles wissen met prefix (als je die gebruikt)
    // Dit is de echte “coin op 0” reset.
    const prefixes = [
      "coin:",       // bv coin:PEPE stage/enteredAt/cooldown/peakOb
      "ob:",         // bv ob:PEPE samples
      "stage:",      // bv stage:PEPE
      "cooldown:",   // bv cooldown:PEPE
      "seen:",       // bv seen:PEPE
      "history:"     // bv history:PEPE
    ];

    // Scan + delete op basis van prefix (Upstash ondersteunt SCAN)
    // Let op: als je deze prefixes niet gebruikt, is dit alsnog veilig.
    for (const p of prefixes) {
      let cursor = "0";
      do {
        const [next, keys] = await kv.scan(cursor, { match: `${p}*`, count: 500 });
        cursor = next;
        if (keys?.length) await Promise.all(keys.map((k) => kv.del(k)));
      } while (cursor !== "0");
    }

    return res.status(200).json({
      success: true,
      message: "Harde reset klaar. Alle coins starten weer op 0.",
      cleared: { fixedKeys: KEYS.length, prefixes }
    });
  } catch (err) {
    console.error("RESET ERROR:", err);
    return res.status(500).json({ error: "Reset failed" });
  }
}