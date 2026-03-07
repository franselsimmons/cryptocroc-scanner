// ... (hele bestand zoals in vorige antwoord, maar met de volgende aanpassing in de BTC flip sectie)

      // BTC flip -> close open positions (portfolio logic)
      if (!allowed && MOON.portfolio.closeOnBtcFlip && positions.open.length) {
        const cgNow = await fetchCoinGeckoTopCached();
        const priceMap = buildSymbolPriceMap(cgNow);

        const toReview = [...positions.open];
        positions.open = [];

        for (const t of toReview) {
          const px = priceMap.get(t.symbol) || Number(t.lastPrice || t.entryPrice || 0) || Number(t.entryPrice || 0);
          const pnlPct = calcPnlPct({ mode: t.mode, entryPrice: t.entryPrice, priceNow: px });
          const pnlUsd = (Number(t.posUsd || MOON.portfolio.posUsd) * pnlPct) / 100;
          const ageMin = Math.round((now - Number(t.entryAt || now)) / 60000);

          const shouldForceClose =
            Number(px || 0) === 0 ||
            Math.abs(Number(pnlPct || 0)) < 1.5 ||
            ageMin >= 180; // sluit na 3 uur tegen BTC regime in

          if (shouldForceClose) {
            const closedTrade = {
              ...t,
              status: "SELL",
              exitReason: "BTC_GATE_FLIP",
              exitAt: now,
              exitPrice: +Number(px || t.entryPrice).toFixed(8),
              pnlPct: +pnlPct.toFixed(2),
              pnlUsd: +pnlUsd.toFixed(2),
            };

            positions.closed.push(closedTrade);

            await closeMoonTradeMirror({
              mode: t.mode,
              symbol: t.symbol,
              priceNow: px,
              reason: "BTC_GATE_FLIP",
            });

            const hook = webhookMoonPortfolio() || webhookForMoonStage("ELITE");
            if (hook) {
              const mins = durMinutes(closedTrade.entryAt, closedTrade.exitAt);

              const msg =
                `**${closedTrade.symbol}** → **SELL** (MOON ${fmtModeLabel(closedTrade.mode)})\n` +
                `Opened: ${fmtTs(closedTrade.entryAt)}\n` +
                `Closed: ${fmtTs(closedTrade.exitAt)}\n` +
                `Duration: ${mins} min\n` +
                `Reason: BTC_GATE_FLIP\n` +
                `Exit: $${Number(closedTrade.exitPrice).toFixed(8)} | PnL: ${closedTrade.pnlPct >= 0 ? "+" : ""}${closedTrade.pnlPct}% ($${closedTrade.pnlUsd})`;
              await sendDiscord(hook, msg);
            }
          } else {
            positions.open.push({
              ...t,
              status: "HOLD",
              lastPrice: +Number(px || t.lastPrice || t.entryPrice).toFixed(8),
              note: "BTC flip soft-hold",
            });
          }
        }
      }

// ... (rest ongewijzigd)