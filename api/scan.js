// ... alle bovenstaande helpers (fetchBtc, fetchCgTop, enz.) blijven ongewijzigd ...

// ======================================================
// MAIN HANDLER
// ======================================================
export default async function handler(req, res) {
  try {
    if (!requireSecret(req, res)) return;

    const mode = getMode(req); // "bull" or "bear"

    const coreMod = await import(`../lib/_core_${mode}.js`);
    const core = coreMod?.default ? coreMod.default : coreMod;

    const now = Date.now();

    // =====================
    // UNIVERSE CACHE (1x CG per cron)
    // =====================
    const UNIVERSE_MAX_AGE_MS = 29 * 60 * 1000;

    let universe = await kv.get("universe:latest");
    const uniTs = Number(universe?.ts || 0);
    const uniStale = !uniTs || (now - uniTs) > UNIVERSE_MAX_AGE_MS;

    // fallback: als universe ontbreekt/oud is → 1x vullen (handmatige scans blijven werken)
    if (uniStale) {
      const freshBtc = await fetchBtc();
      const freshCoins = await fetchCgTop(core.SETTINGS.CG_TOP);
      universe = { ts: now, btc: freshBtc, coins: freshCoins, limit: core.SETTINGS.CG_TOP };
      await kv.set("universe:latest", universe);
    }

    const btcBase = universe.btc;
    const cg = universe.coins;

    // Vervangen door compat‑versies
    const btcState = computeBtcStateCompat(btcBase, core.SETTINGS);
    const btcTune = btcConfidenceAdjustCompat(mode, btcState, btcBase, core.SETTINGS);
    const btc = { ...btcBase, state: btcState, tune: btcTune };

    const cap = computeStageCap(mode, btc.state);
    const allowEntry = cap.cap === false;

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");

    // cg is al geladen uit universe
    const radar = [];
    const buildup = [];
    const almost = [];
    const entry = [];
    const openTrades = [];

    const state = (await kv.get(core.keyState(mode))) || {};
    const obMap = await loadObMap(mode);

    const noticesByHook = {};

    for (const c of cg) {
      const radarGate = passRadar(core, c);
      if (!radarGate.ok) continue;

      const vm = radarGate.vm;
      const sym = up(c.symbol);
      const priceNow = n(c.price, 0);

      let stageBase = stageFromSwing(mode, { ...c, vm });

      // OB
      const ob = await getObForSymbol({ mode, symbol: sym, obMap });

      const obTs = n(ob?.ts, 0);
      const obAge = obTs > 0 ? now - obTs : Number.POSITIVE_INFINITY;
      const obFresh = !!ob?.fresh;

      const obValid = !!ob?.valid;

      const spreadPct = n(ob?.spreadPct, 999);
      const depthMinUsd1p = n(ob?.depthMinUsd1p, 0);
      const obScore = n(ob?.score, 0);

      const confidenceBase = core.computeConfidence({
        vm,
        change24: c.change24,
        range24: c.range24,
        obValid: !!obValid,
      });

      const confidence = Math.max(0, Math.min(100, n(confidenceBase, 0) + n(btcTune.adj, 0)));

      const thr = adaptiveEntryThresholds(core, c, vm);

      let almostGate = "n/a";
      let entryGate = "n/a";
      let stage = stageBase;

      if (cap.cap && (stageBase === "ALMOST" || stageBase === "ENTRY")) {
        stage = "BUILDUP";
        almostGate = `capped: ${cap.capStage}`;
        entryGate = `capped: ${cap.capStage}`;
      } else {
        let obSamples = null;

        // ALMOST slope gate
        if (stageBase === "ALMOST") {
          obSamples = await kv.get(core.keyObSamples(mode, sym));

          const slopeCheck =
            typeof core.checkObSlopeGate === "function"
              ? core.checkObSlopeGate({
                  stage: "almost",
                  mode,
                  obSamples,
                  settings: core.SETTINGS,
                })
              : { ok: true };

          if (!slopeCheck.ok) {
            stageBase = "BUILDUP";
            stage = "BUILDUP";
            almostGate = slopeCheck.reason || "OB slope failed in ALMOST";
          } else {
            almostGate = "passed";
          }
        }

        // ENTRY gate
        if (stageBase === "ALMOST") {
          if (!ob || ob.ok === false) entryGate = "OB missing";
          else if (!obFresh) entryGate = `OB stale (${Math.round(obAge / 1000)}s)`;
          else if (!obValid) entryGate = "OB invalid";
          else if (confidence < n(thr.minConfidence, 0)) entryGate = `Confidence < ${thr.minConfidence}`;
          else if (spreadPct > n(thr.spreadMaxPct, 999)) entryGate = `Spread > ${thr.spreadMaxPct}%`;
          else if (depthMinUsd1p < n(thr.depthMinUsd1p, 0)) entryGate = `Depth1% < $${thr.depthMinUsd1p}`;
          else if (Math.abs(obScore) < n(thr.obScoreMin, 0)) entryGate = `OB score < ${thr.obScoreMin}`;
          else {
            if (!obSamples) obSamples = await kv.get(core.keyObSamples(mode, sym));

            const slopeCheck2 =
              typeof core.checkObSlopeGate === "function"
                ? core.checkObSlopeGate({
                    stage: "entry",
                    mode,
                    obSamples,
                    settings: core.SETTINGS,
                  })
                : { ok: true };

            const pressureDelta = n(ob?.pressureDeltaUsd, 0);
            const pressureOk = mode === "bull" ? pressureDelta >= 0 : pressureDelta <= 0;

            if (!slopeCheck2.ok) entryGate = slopeCheck2.reason || "OB slope failed at ENTRY";
            else if (!pressureOk) entryGate = "Pressure contra";
            else {
              stage = "ENTRY";
              entryGate = "passed";
            }
          }
        }
      }

      // ======================================================
      // TRADE ENGINE
      // ======================================================
      const tKey = kTrade(mode, sym);
      const cdKey = kCooldown(mode, sym);

      const cooldown = await kv.get(cdKey);
      const tradeExisting = await kv.get(tKey);

      let tradeInfo = null;

      if (tradeExisting && tradeExisting?.status === "OPEN") {
        const entryPrice = n(tradeExisting.entryPrice, 0);
        const barsOpen = n(tradeExisting.barsOpen, 0) + 1;

        const pnl = calcPnlPct(mode, entryPrice, priceNow);
        const maxPnl = Math.max(n(tradeExisting.maxPnl, 0), pnl);

        const stopPct = stopPctFromRange24(c.range24);

        const hardStopHit =
          String(mode).toLowerCase() === "bear"
            ? priceNow >= entryPrice * (1 + stopPct)
            : priceNow <= entryPrice * (1 - stopPct);

        const obAgainst = obFresh ? isObAgainst(mode, ob) : false;
        const obInvalid = isObInvalidFresh(obFresh, ob);
        const badNow = obFresh && (obAgainst || obInvalid);
        const obBadStreak = badNow ? n(tradeExisting.obBadStreak, 0) + 1 : 0;

        const obBreakHit = obBadStreak >= 2;
        const timeStopHit = barsOpen >= TIME_STOP_SCANS && maxPnl < TIME_STOP_MAXPNL;

        const drawdown = maxPnl - pnl;

        let trailHit = false;
        let trailCfg = null;

        if (maxPnl >= TP2_PNL) {
          trailHit = drawdown >= TRAIL_AFTER_TP2;
          trailCfg = { level: "TP2", trail: TRAIL_AFTER_TP2, drawdown };
        } else if (maxPnl >= TP1_PNL) {
          trailHit = drawdown >= TRAIL_AFTER_TP1;
          trailCfg = { level: "TP1", trail: TRAIL_AFTER_TP1, drawdown };
        }

        let exit = null;
        if (hardStopHit) exit = { reason: "HARD_STOP", stopPct, pnl };
        else if (trailHit) exit = { reason: "TRAILING_TP", pnl, maxPnl, trailCfg };
        else if (obBreakHit) exit = { reason: "OB_BREAK_2X", obBadStreak, obFresh, obValid, obAgainst, pnl };
        else if (timeStopHit) exit = { reason: "TIME_STOP_NO_MOMENTUM", barsOpen, maxPnl, pnl };

        if (exit) {
          await kv.del(tKey);
          await kv.set(cdKey, { ts: now, reason: exit.reason }, { ex: REENTRY_COOLDOWN_SEC });

          const tradeId = String(tradeExisting.tradeId || "");

          await logSell(mode, {
            ts: now,
            tradeId,
            symbol: sym,
            side: String(mode).toLowerCase(),
            reason: exit.reason,
            pnlPct: pnl,
            maxPnlPct: maxPnl,
            entryPrice,
            exitPrice: priceNow,
            barsOpen,
            extra: exit?.trailCfg ? { trailCfg: exit.trailCfg } : undefined,
          });

          const givebackPct = Math.max(0, (maxPnl - pnl) * 100);

          await safePushEvent("main", {
            type: "trade_close",
            tradeId,
            mode,
            symbol: sym,
            reason: exit.reason,
            entryPrice,
            exitPrice: priceNow,
            pnlPct: pnl * 100,
            maxPnlPct: maxPnl * 100,
            givebackPct,
            barsOpen,
          });

          const hook = stageWebhook("SELL");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `**SELL** • ${exit.reason}  ` +
            `pnl ${fmtPct(pnl * 100, 2)} • max ${fmtPct(maxPnl * 100, 2)} • ` +
            `giveback ${fmtPct(givebackPct, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);

          tradeInfo = { status: "CLOSED", exit, pnl, maxPnl, exitAt: now, barsOpen };
        } else {
          const updated = {
            ...tradeExisting,
            barsOpen,
            maxPnl,
            lastPrice: priceNow,
            lastSeenAt: now,
            obBadStreak,
          };

          if (!updated.holdNotified && barsOpen >= HOLD_AFTER_SCANS) {
            const hook = stageWebhook("HOLD");
            const line =
              `**${sym}** (${mode.toUpperCase()})  ` +
              `**HOLD** • trade loopt  ` +
              `pnl ${fmtPct(pnl * 100, 2)} • max ${fmtPct(maxPnl * 100, 2)} • ` +
              `price ${fmtUsd(priceNow, 6)}`;
            pushNotice(noticesByHook, hook, line);
            updated.holdNotified = true;
          }

          await kv.set(tKey, updated, { ex: TRADE_TTL_SEC });

          tradeInfo = {
            status: "OPEN",
            tradeId: String(updated.tradeId || ""),
            entryPrice,
            entryAt: n(updated.entryAt, 0),
            barsOpen,
            pnl,
            maxPnl,
            stopPct,
            obBadStreak,
            trail: { tp1: TP1_PNL, tp2: TP2_PNL, dd: maxPnl - pnl },
          };
        }
      }

      if (!tradeInfo) {
        const inCooldown = !!cooldown;
        const isEntrySignal = stage === "ENTRY" && allowEntry;

        if (isEntrySignal && !inCooldown && priceNow > 0) {
          const tradeId = makeTradeId(mode, sym);

          const tradeObj = {
            status: "OPEN",
            tradeId,
            mode,
            symbol: sym,
            entryPrice: priceNow,
            entryAt: now,
            barsOpen: 0,
            maxPnl: 0,
            obBadStreak: 0,
            holdNotified: false,
            lastSeenAt: now,
            lastPrice: priceNow,
            entryConfidence: confidence,
            entryVm: vm,
            entryRange24: c.range24,
            entryMeta: { entryGate, almostGate, confidence, vm, spreadPct, depthMinUsd1p, obScore },
          };

          await kv.set(tKey, tradeObj, { ex: TRADE_TTL_SEC });

          await safePushEvent("main", {
            type: "trade_open",
            tradeId,
            mode,
            symbol: sym,
            entryPrice: priceNow,
            confidence,
            vm,
            entryGate,
          });

          const hook = stageWebhook("ENTRY");
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `**ENTRY** • instap  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);

          tradeInfo = { status: "OPEN", tradeId, entryPrice: priceNow, entryAt: now, barsOpen: 0, pnl: 0, maxPnl: 0 };
        }
      }

      const prevEntry = safeObj(state[sym]) || {};
      const stFix = updateStateAndConsistency(state, sym, stage, core, now);

      const prevStage = up(stFix.prevStage);
      const currStage = up(stage);

      if (prevStage && prevStage !== currStage) {
        await safePushEvent("main", {
          type: "stage_change",
          mode,
          symbol: sym,
          from: prevStage,
          to: currStage,
          reason:
            currStage === "ENTRY"
              ? entryGate
              : currStage === "ALMOST"
              ? almostGate
              : "stage_logic",
          confidence,
          vm,
        });
      }

      const hasOpenTrade = tradeInfo?.status === "OPEN";

      if (!hasOpenTrade && prevStage) {
        const doNotify = canNotify(prevEntry, now);
        const isFunnelStage = currStage === "RADAR" || currStage === "BUILDUP" || currStage === "ALMOST";

        if (doNotify && isFunnelStage && prevStage !== currStage) {
          const hook = stageWebhook(currStage);
          const line =
            `**${sym}** (${mode.toUpperCase()})  ` +
            `${prevStage} → **${currStage}**  ` +
            `conf ${n(confidence, 0)}/100 • vm ${fmtNum(vm, 2)} • ` +
            `1h ${fmtPct(c.change1h, 2)} • 24h ${fmtPct(c.change24, 2)} • ` +
            `price ${fmtUsd(priceNow, 6)}`;
          pushNotice(noticesByHook, hook, line);
          markNotified(state, sym, now);
        }
      }

      if (tradeInfo?.status === "OPEN") {
        openTrades.push({
          symbol: sym,
          side: String(mode).toLowerCase(),
          tradeId: String(tradeInfo.tradeId || ""),
          entryPrice: n(tradeInfo.entryPrice, 0),
          entryAt: n(tradeInfo.entryAt, 0),
          barsOpen: n(tradeInfo.barsOpen, 0),
          pnlPct: n(tradeInfo.pnl, 0),
          maxPnlPct: n(tradeInfo.maxPnl, 0),
          price: priceNow,
          confidence,
          vm,
        });
      }

      const item = {
        id: c.id,
        symbol: sym,
        name: c.name,
        price: priceNow,
        volume: c.volume,
        marketCap: c.marketCap,
        change24: +c.change24.toFixed(4),
        change1h: +c.change1h.toFixed(4),
        range24: +c.range24.toFixed(4),
        vm: +vm.toFixed(6),
        volAcc: +vm.toFixed(6),

        confidenceBase,
        confidence,
        confidenceBtcAdj: btcTune.adj,

        stage: currStage,

        trade: tradeInfo,
        tradeStatus: pageTradeStatus(tradeInfo),

        stageScans: stFix.stageScans,
        consistency: stFix.consistency,

        req: {
          minConfidence: thr.minConfidence,
          spreadMaxPct: thr.spreadMaxPct,
          depthMinUsd1p: thr.depthMinUsd1p,
          obScoreMin: thr.obScoreMin,
        },

        ob: ob
          ? {
              valid: !!ob.valid,
              fresh: !!ob.fresh,
              stale: !!ob.stale,
              ageSec: obTs > 0 ? Math.round(obAge / 1000) : ob.ageSec ?? null,
              reason: String(ob.reason || ""),
              score: Number(n(obScore, 0)),
              spreadPct: Number(n(spreadPct, 999)),
              depthMinUsd1p: Number(n(depthMinUsd1p, 0)),
              pressureDeltaUsd: Number(n(ob.pressureDeltaUsd, 0)),
              ts: obTs || null,
            }
          : { status: "none" },

        why: { almostGate, entryGate },
      };

      if (currStage === "ENTRY") entry.push(item);
      else if (currStage === "ALMOST") almost.push(item);
      else if (currStage === "BUILDUP") buildup.push(item);
      else radar.push(item);
    }

    entry.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    almost.sort((a, b) => b.confidence - a.confidence || b.vm - a.vm);
    buildup.sort((a, b) => b.vm - a.vm);
    radar.sort((a, b) => b.vm - a.vm);

    openTrades.sort((a, b) => b.pnlPct - a.pnlPct || b.maxPnlPct - a.maxPnlPct);

    const discord = await flushNotices(noticesByHook);

    const sellsRaw = (await kv.get(kSells(mode))) || [];
    const sellsArr = Array.isArray(sellsRaw) ? sellsRaw.slice(-SELLS_KEEP) : [];
    const recentSells = sellsArr.slice().reverse();
    const stats = computeStatsFromSells(sellsArr);

    const btcCfg = safeObj(core.SETTINGS?.btc) || {};
    const neutral24Pct = n(btcCfg.neutral24Pct, 1.0);
    const fine1hAbsPct = n(btcCfg.fine1hAbsPct, 0.25);
    const confBoost = n(btcCfg.confBoost, 4);

    const result = {
      ok: true,
      ts: now,
      mode,
      btc,
      meta: {
        cadence: "30m",
        btcPolicy:
          "24h regime + 1h confidence fine-tune; NEUTRAL/opposite => cap to BUILDUP (prep), maar scan+OB blijven lopen",
        capActive: !!cap.cap,
        capStage: cap.capStage,
        capReason: cap.reason,
        allowEntry,
        neutralZone: `BTC 24h tussen -${neutral24Pct}% en +${neutral24Pct}%`,
        fineTune: `BTC 1h abs >= ${fine1hAbsPct}% => confidence +/-${confBoost}`,
        tradeEngine: {
          enabled: true,
          timeStopScans: TIME_STOP_SCANS,
          timeStopMaxPnlPct: TIME_STOP_MAXPNL * 100,
          reentryCooldownSec: REENTRY_COOLDOWN_SEC,
          tradeTtlSec: TRADE_TTL_SEC,
          sellsLogKey: kSells(mode),
          exits: [
            "HARD_STOP(range24)",
            "TRAILING_TP(maxPnl + drawdown)",
            "OB_BREAK_2X(fresh)",
            "TIME_STOP(no momentum)",
          ],
          trailing: {
            tp1Pct: TP1_PNL * 100,
            tp2Pct: TP2_PNL * 100,
            trailAfterTp1Pct: TRAIL_AFTER_TP1 * 100,
            trailAfterTp2Pct: TRAIL_AFTER_TP2 * 100,
          },
        },
      },
      counts: {
        entry: entry.length,
        almost: almost.length,
        buildup: buildup.length,
        radar: radar.length,
        openTrades: openTrades.length,
        recentSells: recentSells.length,
      },
      funnel: { entry, almost, buildup, radar },
      trading: {
        openTrades,
        recentSells,
        stats: {
          ...stats,
          winrate50Pct: stats.winrate50 * 100,
          avgPnl50Pct: stats.avgPnl50 * 100,
        },
      },
      obMap: obMap ? { ok: true, size: Object.keys(obMap).length } : { ok: false },
      discord: {
        enabled: true,
        sent: discord.sent,
        failed: discord.failed,
        errors: (discord.details || []).slice(0, 5),
      },
      note:
        "Scan logs stage_change + trade_open/close (met tradeId + giveback) events naar cc:events:main:list (voor analyzer).",
    };

    await kv.set(core.keyLatest(mode), result);
    await kv.set(core.keyState(mode), state);

    res.statusCode = 200;
    return res.end(JSON.stringify(result));
  } catch (e) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    return res.end(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  }
}