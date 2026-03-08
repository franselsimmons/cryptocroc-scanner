// moon.js – gebruik de publieke endpoint zonder token

const MODES = {
  bull: 'LONG',
  bear: 'SHORT'
};

let currentMode = 'bull';

async function fetchMoonData(mode) {
  const url = `/api/moon/public-latest?mode=${mode}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Onbekende fout');
    renderFunnel(data);
  } catch (err) {
    document.getElementById('error').innerText = 'Fout: ' + err.message;
  }
}

function renderFunnel(data) {
  const container = document.getElementById('funnel-container');
  const btcInfo = document.getElementById('btc-info');
  const portfolioInfo = document.getElementById('portfolio-info');

  // BTC info
  if (data.btc) {
    btcInfo.innerText = `BTC: ${data.btc.state} | 24h: ${data.btc.chg24?.toFixed(2)}% | range: ${data.btc.range24?.toFixed(2)}%`;
  }

  // Portfolio
  if (data.portfolio) {
    portfolioInfo.innerText = `Portfolio: open ${data.portfolio.openCount} · closed ${data.portfolio.closedCount} · PnL $${data.portfolio.realizedUsd}`;
  }

  // Funnel secties
  const sections = ['elite', 'almost', 'buildup', 'radar'];
  let html = '';
  for (const section of sections) {
    const items = data.funnel?.[section] || [];
    if (items.length === 0) continue;
    html += `<div class="section"><h2>${section.toUpperCase()}</h2><ul>`;
    items.forEach(coin => {
      html += `<li><strong>${coin.symbol}</strong> – conf: ${coin.confidence} – $${coin.price?.toFixed(coin.price < 0.01 ? 8 : 4)}`;
      if (coin.trade) {
        html += ` <span class="trade">(${coin.trade.status === 'ENTRY' ? '🆕' : '📌'} PnL: ${coin.trade.pnlPct?.toFixed(2)}%)</span>`;
      }
      html += '</li>';
    });
    html += '</ul></div>';
  }
  container.innerHTML = html || '<p>Geen data beschikbaar</p>';
}

// Mode toggle
document.getElementById('mode-bull').addEventListener('click', () => {
  currentMode = 'bull';
  document.getElementById('mode-label').innerText = MODES.bull;
  fetchMoonData(currentMode);
});

document.getElementById('mode-bear').addEventListener('click', () => {
  currentMode = 'bear';
  document.getElementById('mode-label').innerText = MODES.bear;
  fetchMoonData(currentMode);
});

// Initial load
fetchMoonData(currentMode);