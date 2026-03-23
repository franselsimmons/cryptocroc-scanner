<!DOCTYPE html>
<html lang="nl">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=yes">
    <title>AI Dashboard – Performance Optimizer</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background: #0a0f1c;
            font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, sans-serif;
            padding: 24px 20px;
            color: #eef2ff;
        }

        .dashboard {
            max-width: 1400px;
            margin: 0 auto;
        }

        h1 {
            font-size: 1.8rem;
            font-weight: 600;
            letter-spacing: -0.3px;
            background: linear-gradient(135deg, #fff, #94a3b8);
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            margin-bottom: 8px;
        }

        .sub {
            color: #6c7a91;
            margin-bottom: 32px;
            border-left: 3px solid #22c55e;
            padding-left: 14px;
            font-weight: 450;
        }

        /* grid layout */
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
            gap: 24px;
        }

        /* card styling */
        .card {
            background: #0f1622;
            border-radius: 24px;
            border: 1px solid #1e2a3a;
            overflow: hidden;
            backdrop-filter: blur(2px);
            transition: all 0.2s ease;
        }

        .card-header {
            padding: 16px 20px;
            background: rgba(15, 22, 34, 0.8);
            border-bottom: 1px solid #1e2a3a;
            display: flex;
            align-items: baseline;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 8px;
        }

        .card-header h2 {
            font-size: 1.35rem;
            font-weight: 600;
            letter-spacing: -0.2px;
        }

        .badge {
            background: #1e2a3a;
            padding: 4px 10px;
            border-radius: 40px;
            font-size: 0.7rem;
            font-weight: 500;
            color: #9ca9c2;
        }

        .card-content {
            padding: 20px;
        }

        /* TOP FIX banner */
        .topfix {
            background: linear-gradient(180deg, #132033, #0b1624);
            border: 1px solid #1f2a3a;
            border-left: 4px solid #22c55e;
            border-radius: 14px;
            padding: 14px;
            margin-bottom: 18px;
            font-weight: 600;
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.2);
        }

        .topfix .gain {
            color: #86efac;
            font-size: 13px;
            margin-top: 5px;
            display: inline-block;
            font-weight: 500;
        }

        /* improvements list */
        .improvements-list {
            list-style: none;
            margin-top: 6px;
        }

        .improvements-list li {
            background: #0c1220;
            margin-bottom: 10px;
            padding: 12px 14px;
            border-radius: 14px;
            border-left: 3px solid #2d3b4f;
            font-size: 0.85rem;
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            gap: 8px;
            transition: background 0.1s;
        }

        .improvements-list li:hover {
            background: #111827;
        }

        .advice-text {
            flex: 1;
            font-weight: 500;
            color: #e2e8f0;
        }

        .gain-badge {
            background: #1e2a3a;
            padding: 4px 10px;
            border-radius: 30px;
            font-size: 0.7rem;
            font-weight: 600;
            color: #bbf7d0;
            white-space: nowrap;
        }

        .section-title {
            font-size: 0.75rem;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: #5b6e8c;
            margin-bottom: 12px;
            font-weight: 600;
        }

        hr {
            border-color: #1e2a3a;
            margin: 18px 0;
        }

        @media (max-width: 760px) {
            body {
                padding: 16px;
            }
            .card-content {
                padding: 16px;
            }
        }

        footer {
            text-align: center;
            margin-top: 48px;
            font-size: 0.75rem;
            color: #475569;
            border-top: 1px solid #1e2a3a;
            padding-top: 24px;
        }
    </style>
</head>
<body>
<div class="dashboard">
    <h1>⚡ AI Performance Dashboard</h1>
    <div class="sub">Prioriteiten op basis van frequentie + ernst · verwachte winst in %</div>

    <div class="grid" id="dashboard-root">
        <!-- dynamisch gevuld via JS -->
        <div class="loading">🔮 AI analyseert bottlenecks...</div>
    </div>
    <footer>
        🧠 AI Optimizer v2 · gewogen prioriteiten (impact x frequentie) · <strong>“Fix eerst”</strong> toont grootste potentieel
    </footer>
</div>

<script>
    // ---------- helper utilities ----------
    function safeArr(val) {
        return Array.isArray(val) ? val : [];
    }

    function n(val, fallback = 0) {
        const num = parseFloat(val);
        return isNaN(num) ? fallback : num;
    }

    // ---------- CORE AI engine (exact zoals requested) ----------
    function buildAIImprovements(problems) {
        const map = {};

        for (const p of safeArr(problems)) {
            const severity = 10 - n(p.score, 0); // score 0-10, hoe slechter score → hoger gewicht

            for (const adv of safeArr(p.advice)) {
                const key = adv.toLowerCase().trim();

                if (!map[key]) {
                    map[key] = {
                        label: adv,
                        count: 0,
                        impact: 0,
                    };
                }

                map[key].count++;
                map[key].impact += severity;
            }
        }

        const list = Object.values(map)
            .map((x) => {
                const expectedGain = Math.round(
                    Math.min(25, (x.impact / 10) + x.count * 1.5)
                );
                return {
                    ...x,
                    priority: x.impact + x.count * 2,
                    expectedGain,
                };
            })
            .sort((a, b) => b.priority - a.priority)
            .slice(0, 5);

        const top = list[0];

        return {
            topFix: top
                ? {
                    label: top.label,
                    gain: top.expectedGain,
                }
                : null,
            list,
        };
    }

    // ---------- HTML render helpers ----------
    function esc(str) {
        if (!str) return '';
        return String(str).replace(/[&<>]/g, function(m) {
            if (m === '&') return '&amp;';
            if (m === '<') return '&lt;';
            if (m === '>') return '&gt;';
            return m;
        }).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, function(c) {
            return c;
        });
    }

    function renderTopFix(fix) {
        if (!fix || !fix.label) return "";
        return `
            <div class="topfix">
                🚀 <b>Fix eerst:</b> ${esc(fix.label)}<br/>
                <span class="gain">→ verwacht +${esc(fix.gain)}% performance</span>
            </div>
        `;
    }

    function renderImprovementsList(improvements) {
        if (!improvements || improvements.length === 0) {
            return '<div style="color:#6c7a91; font-style:italic;">✨ Geen verbetersuggesties</div>';
        }
        return `
            <div class="section-title">📋 TOP 5 VERBETERINGEN</div>
            <ul class="improvements-list">
                ${improvements.map(imp => `
                    <li>
                        <span class="advice-text">🔹 ${esc(imp.label)}</span>
                        <span class="gain-badge">+${esc(imp.expectedGain)}%</span>
                    </li>
                `).join('')}
            </ul>
        `;
    }

    // ---------- render één volledige kaart (bull / bear) ----------
    function renderStrategyCard(title, typeLabel, dataSegment) {
        // dataSegment verwacht: { problems, topFix, topImprovements }
        if (!dataSegment) {
            return `
                <div class="card">
                    <div class="card-header"><h2>${esc(title)}</h2><span class="badge">⚠️ geen data</span></div>
                    <div class="card-content">Geen analyse beschikbaar</div>
                </div>
            `;
        }

        const topFixHtml = renderTopFix(dataSegment.topFix);
        const improvementsHtml = renderImprovementsList(dataSegment.topImprovements || []);

        return `
            <div class="card">
                <div class="card-header">
                    <h2>${esc(title)}</h2>
                    <span class="badge">${esc(typeLabel)}</span>
                </div>
                <div class="card-content">
                    ${topFixHtml}
                    ${improvementsHtml}
                </div>
            </div>
        `;
    }

    // ---------- MOCK DATA met realistische problemen + advice ----------
    // Hier simuleren we de payload zoals in je originele architectuur
    function generateMockPayload() {
        // MAIN BULL problemen
        const mainBullProblems = [
            { score: 7.2, advice: ["Alleen high conviction setups", "Verminder overtrading", "Focus op A+ setups"] },
            { score: 4.5, advice: ["Te veel risico per trade", "Geen duidelijke stop loss", "Alleen high conviction setups"] },
            { score: 8.1, advice: ["Emotioneel handelen na verlies", "Alleen high conviction setups"] },
            { score: 6.0, advice: ["Geen trade journal", "Verminder overtrading"] },
            { score: 2.9, advice: ["Te grote posities", "Te veel risico per trade"] },
        ];

        // MAIN BEAR
        const mainBearProblems = [
            { score: 3.2, advice: ["Short setups niet afwachten", "Gebruik trailing stop", "Wees geduldig bij daling"] },
            { score: 5.5, advice: ["Te vroeg shorten", "Gebruik trailing stop"] },
            { score: 7.8, advice: ["Geen duidelijke exit strategie", "Gebruik trailing stop", "Emotioneel shorten"] },
            { score: 4.2, advice: ["Geen risico management", "Te vroeg shorten"] },
        ];

        // MOON BULL
        const moonBullProblems = [
            { score: 6.5, advice: ["FOMO bij pieken", "Alleen high conviction setups", "Blijf bij plan"] },
            { score: 4.9, advice: ["Geen volume check", "FOMO bij pieken"] },
            { score: 8.3, advice: ["Te veel leverage", "Risico per trade te hoog", "Alleen high conviction setups"] },
            { score: 5.0, advice: ["Geen duidelijke take profit"] },
        ];

        // MOON BEAR
        const moonBearProblems = [
            { score: 7.0, advice: ["Short squeezes negeren", "Gebruik wider stops", "Te veel risico in moon fase"] },
            { score: 6.2, advice: ["Te vroeg omschakelen", "Gebruik wider stops"] },
            { score: 4.3, advice: ["Geen wekelijkse analyse", "Short squeezes negeren"] },
        ];

        // TRADE algemeen
        const tradeProblems = [
            { score: 5.8, advice: ["Geen pre-market check", "Verbeter executie", "Gebruik limiet orders"] },
            { score: 3.5, advice: ["Te veel slippage", "Gebruik limiet orders"] },
            { score: 7.4, advice: ["Emotionele entries", "Verbeter executie", "Geen pre-market check"] },
            { score: 6.9, advice: ["Risk per trade inconsistent", "Gebruik limiet orders"] },
        ];

        // Bouw AI voor elke categorie
        const mainBullAI = buildAIImprovements(mainBullProblems);
        const mainBearAI = buildAIImprovements(mainBearProblems);
        const moonBullAI = buildAIImprovements(moonBullProblems);
        const moonBearAI = buildAIImprovements(moonBearProblems);
        const tradeAI = buildAIImprovements(tradeProblems);

        // volledige payload zoals in jouw omschrijving
        return {
            main: {
                bull: {
                    problems: mainBullProblems,
                    topFix: mainBullAI.topFix,
                    topImprovements: mainBullAI.list,
                },
                bear: {
                    problems: mainBearProblems,
                    topFix: mainBearAI.topFix,
                    topImprovements: mainBearAI.list,
                }
            },
            moon: {
                bull: {
                    problems: moonBullProblems,
                    topFix: moonBullAI.topFix,
                    topImprovements: moonBullAI.list,
                },
                bear: {
                    problems: moonBearProblems,
                    topFix: moonBearAI.topFix,
                    topImprovements: moonBearAI.list,
                }
            },
            trade: {
                problems: tradeProblems,
                topFix: tradeAI.topFix,
                topImprovements: tradeAI.list,
            }
        };
    }

    // ---------- RENDER DASHBOARD (alle secties) ----------
    function renderDashboard(payload) {
        if (!payload) return '<div class="error">⚠️ Geen payload ontvangen</div>';

        // main bull & bear
        const mainBullCard = renderStrategyCard('🔥 MAIN Bull', 'bull', payload.main?.bull);
        const mainBearCard = renderStrategyCard('📉 MAIN Bear', 'bear', payload.main?.bear);
        // moon bull & bear
        const moonBullCard = renderStrategyCard('🌕 MOON Bull', 'bull', payload.moon?.bull);
        const moonBearCard = renderStrategyCard('🌑 MOON Bear', 'bear', payload.moon?.bear);
        // trade card (speciaal)
        let tradeCard = '';
        if (payload.trade) {
            const tradeFixHtml = renderTopFix(payload.trade.topFix);
            const tradeImproveHtml = renderImprovementsList(payload.trade.topImprovements);
            tradeCard = `
                <div class="card">
                    <div class="card-header">
                        <h2>⚡ TRADE EXECUTION</h2>
                        <span class="badge">multi-asset</span>
                    </div>
                    <div class="card-content">
                        ${tradeFixHtml}
                        ${tradeImproveHtml}
                    </div>
                </div>
            `;
        } else {
            tradeCard = `<div class="card"><div class="card-header"><h2>⚡ TRADE</h2></div><div class="card-content">Geen data</div></div>`;
        }

        return `
            ${mainBullCard}
            ${mainBearCard}
            ${moonBullCard}
            ${moonBearCard}
            ${tradeCard}
        `;
    }

    // ---------- BOOTSTRAP ----------
    function init() {
        const container = document.getElementById('dashboard-root');
        if (!container) return;

        // Genereer de volledige payload met AI verbeteringen
        const dashboardPayload = generateMockPayload();

        // (Optioneel) log voor debugging: toon topFix per categorie
        console.log('🧠 AI ACTIONS:', {
            mainBullTopFix: dashboardPayload.main.bull.topFix,
            mainBearTopFix: dashboardPayload.main.bear.topFix,
            moonBullTopFix: dashboardPayload.moon.bull.topFix,
            moonBearTopFix: dashboardPayload.moon.bear.topFix,
            tradeTopFix: dashboardPayload.trade.topFix,
        });

        const html = renderDashboard(dashboardPayload);
        container.innerHTML = html;
    }

    init();
</script>
</body>
</html>