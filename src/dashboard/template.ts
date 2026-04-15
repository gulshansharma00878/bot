export function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Hyperliquid Trading Bot</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    background: #0a0e17;
    color: #e1e8f0;
    min-height: 100vh;
  }
  .header {
    background: linear-gradient(135deg, #0f1923 0%, #1a1f36 100%);
    border-bottom: 1px solid #1e293b;
    padding: 16px 24px;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .header h1 {
    font-size: 18px;
    font-weight: 600;
    color: #38bdf8;
  }
  .header .status {
    display: flex;
    gap: 16px;
    align-items: center;
    font-size: 13px;
  }
  .badge {
    padding: 4px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge-live { background: #dc2626; color: #fff; }
  .badge-paper { background: #f59e0b; color: #000; }
  .badge-running { background: #22c55e; color: #000; }
  .badge-stopped { background: #6b7280; color: #fff; }
  .badge-tripped { background: #dc2626; color: #fff; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.5} }

  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 12px;
    padding: 16px 24px;
  }
  .grid-wide {
    grid-template-columns: 1fr 1fr;
  }
  .grid-full {
    grid-template-columns: 1fr;
  }

  .card {
    background: #111827;
    border: 1px solid #1e293b;
    border-radius: 8px;
    padding: 16px;
  }
  .card h2 {
    font-size: 11px;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 8px;
  }
  .card .value {
    font-size: 24px;
    font-weight: 700;
  }
  .card .sub {
    font-size: 12px;
    color: #64748b;
    margin-top: 4px;
  }
  .green { color: #22c55e; }
  .red { color: #ef4444; }
  .yellow { color: #f59e0b; }
  .blue { color: #38bdf8; }

  .section { padding: 0 24px 16px; }
  .section h3 {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
    color: #94a3b8;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th {
    text-align: left;
    padding: 8px 12px;
    background: #0f172a;
    color: #64748b;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid #1e293b;
  }
  td {
    padding: 10px 12px;
    border-bottom: 1px solid #1e293b;
  }
  tr:hover { background: #0f172a; }

  .price-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
  }
  .price-card {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 14px;
  }
  .price-card .symbol {
    font-size: 14px;
    font-weight: 700;
    color: #38bdf8;
  }
  .price-card .price {
    font-size: 22px;
    font-weight: 700;
    margin: 6px 0;
  }
  .price-card .funding {
    font-size: 12px;
  }

  .chart-container {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 16px;
    height: 250px;
    position: relative;
  }
  .chart-canvas {
    width: 100%;
    height: 100%;
  }

  .pos-card {
    background: #0f172a;
    border-radius: 6px;
    padding: 14px;
    border-left: 3px solid;
    margin-bottom: 8px;
  }
  .pos-card.long { border-left-color: #22c55e; }
  .pos-card.short { border-left-color: #ef4444; }
  .pos-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .pos-details {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    font-size: 12px;
  }
  .pos-details .label { color: #64748b; }

  .empty-state {
    text-align: center;
    padding: 40px;
    color: #475569;
    font-size: 14px;
  }

  .footer {
    text-align: center;
    padding: 16px;
    font-size: 11px;
    color: #334155;
    border-top: 1px solid #1e293b;
  }

  .refresh-bar {
    display: flex;
    justify-content: space-between;
    padding: 8px 24px;
    font-size: 11px;
    color: #475569;
  }
</style>
</head>
<body>

<div class="header">
  <h1>⚡ Hyperliquid Perps Trading Bot</h1>
  <div class="status">
    <span id="mode-badge" class="badge">-</span>
    <span id="status-badge" class="badge">-</span>
    <span id="cb-badge" class="badge" style="display:none">CIRCUIT BREAKER</span>
    <span id="uptime" style="color:#64748b">Uptime: --</span>
  </div>
</div>

<div class="refresh-bar">
  <span>Network: <strong id="network">-</strong> | Strategy: <strong id="strategy">-</strong></span>
  <span>Auto-refresh every 5s | Last update: <span id="last-update">-</span></span>
</div>

<!-- KPI Cards -->
<div class="grid">
  <div class="card">
    <h2>Capital</h2>
    <div class="value" id="capital">$0</div>
    <div class="sub" id="capital-change">-</div>
  </div>
  <div class="card">
    <h2>Total PnL</h2>
    <div class="value" id="total-pnl">$0</div>
    <div class="sub" id="pnl-pct">-</div>
  </div>
  <div class="card">
    <h2>Win Rate</h2>
    <div class="value" id="win-rate">-</div>
    <div class="sub" id="trade-count">0 trades</div>
  </div>
  <div class="card">
    <h2>Open Positions</h2>
    <div class="value blue" id="open-count">0</div>
    <div class="sub" id="symbols-tracked">-</div>
  </div>
</div>

<!-- Prices -->
<div class="section">
  <h3>Market Prices</h3>
  <div class="price-grid" id="prices-grid">
    <div class="empty-state">Loading...</div>
  </div>
</div>

<!-- Open Positions -->
<div class="section">
  <h3>Open Positions</h3>
  <div id="positions-list">
    <div class="empty-state">No open positions</div>
  </div>
</div>

<!-- Equity Chart -->
<div class="section">
  <h3>Equity Curve</h3>
  <div class="chart-container">
    <canvas id="equity-chart" class="chart-canvas"></canvas>
  </div>
</div>

<!-- Trade History -->
<div class="section">
  <h3>Trade History</h3>
  <div style="overflow-x:auto;">
    <table id="trades-table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Side</th>
          <th>Action</th>
          <th>Price</th>
          <th>Size</th>
          <th>Leverage</th>
          <th>PnL</th>
          <th>Strategy</th>
        </tr>
      </thead>
      <tbody id="trades-body">
        <tr><td colspan="9" class="empty-state">No trades yet</td></tr>
      </tbody>
    </table>
  </div>
</div>

<!-- Hyperliquid Account -->
<div class="section">
  <h3>Hyperliquid Account</h3>
  <div class="grid">
    <div class="card">
      <h2>Account Value</h2>
      <div class="value blue" id="hl-account-value">-</div>
      <div class="sub" id="hl-connection">Connecting...</div>
    </div>
    <div class="card">
      <h2>Margin Used</h2>
      <div class="value" id="hl-margin-used">-</div>
      <div class="sub" id="hl-ntl-pos">-</div>
    </div>
    <div class="card">
      <h2>Withdrawable</h2>
      <div class="value green" id="hl-withdrawable">-</div>
      <div class="sub">Available for withdrawal</div>
    </div>
    <div class="card">
      <h2>On-Chain Positions</h2>
      <div class="value" id="hl-positions-count">0</div>
      <div class="sub" id="hl-positions-list">-</div>
    </div>
  </div>
</div>

<!-- Risk Panel -->
<div class="section">
  <h3>Risk &amp; Performance</h3>
  <div class="grid">
    <div class="card">
      <table>
        <tr><td style="color:#64748b">Max Risk/Trade</td><td id="r-max-risk" style="text-align:right">-</td></tr>
        <tr><td style="color:#64748b">Max Daily Loss</td><td id="r-max-daily" style="text-align:right">-</td></tr>
        <tr><td style="color:#64748b">Max Leverage</td><td id="r-max-lev" style="text-align:right">-</td></tr>
      </table>
    </div>
    <div class="card">
      <table>
        <tr><td style="color:#64748b">Best Trade</td><td id="r-best" style="text-align:right;color:#22c55e">-</td></tr>
        <tr><td style="color:#64748b">Worst Trade</td><td id="r-worst" style="text-align:right;color:#ef4444">-</td></tr>
        <tr><td style="color:#64748b">Profit Factor</td><td id="r-pf" style="text-align:right">-</td></tr>
      </table>
    </div>
    <div class="card">
      <table>
        <tr><td style="color:#64748b">Avg Win</td><td id="r-avg-win" style="text-align:right;color:#22c55e">-</td></tr>
        <tr><td style="color:#64748b">Avg Loss</td><td id="r-avg-loss" style="text-align:right;color:#ef4444">-</td></tr>
        <tr><td style="color:#64748b">Total Fees</td><td id="r-fees" style="text-align:right;color:#f59e0b">-</td></tr>
      </table>
    </div>
    <div class="card">
      <h2>Circuit Breaker</h2>
      <div class="value" id="cb-status">OK</div>
      <div class="sub">Trips when daily loss exceeds limit</div>
    </div>
  </div>
</div>

<div class="footer">Hyperliquid Perpetual Futures Trading Bot &mdash; Zero Gas Fees</div>

<script>
const $ = (s) => document.getElementById(s);

function fmtUsd(v) { return (v >= 0 ? '$' : '-$') + Math.abs(v).toFixed(2); }
function fmtPct(v) { return (v * 100).toFixed(2) + '%'; }
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString() + ' ' + d.toLocaleDateString();
}
function fmtUptime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h + 'h ' + m + 'm ' + sec + 's';
}

async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

async function update() {
  try {
    const [status, prices, positions, trades, equity, risk, account] = await Promise.all([
      fetchJSON('/api/status'),
      fetchJSON('/api/prices'),
      fetchJSON('/api/positions'),
      fetchJSON('/api/trades'),
      fetchJSON('/api/equity'),
      fetchJSON('/api/risk'),
      fetchJSON('/api/account'),
    ]);

    // Status
    const mb = $('mode-badge');
    mb.textContent = status.mode;
    mb.className = 'badge badge-' + status.mode;
    const sb = $('status-badge');
    sb.textContent = status.isRunning ? 'RUNNING' : 'STOPPED';
    sb.className = 'badge badge-' + (status.isRunning ? 'running' : 'stopped');
    $('uptime').textContent = 'Uptime: ' + fmtUptime(status.uptimeSeconds);
    $('network').textContent = status.network;
    $('strategy').textContent = status.strategy;
    $('last-update').textContent = new Date().toLocaleTimeString();

    if (status.circuitBreaker) {
      $('cb-badge').style.display = 'inline';
      $('cb-badge').className = 'badge badge-tripped';
    } else {
      $('cb-badge').style.display = 'none';
    }

    // KPIs
    $('capital').textContent = fmtUsd(status.capital);
    const pnl = status.capital - status.initialCapital;
    $('capital-change').textContent = 'Initial: ' + fmtUsd(status.initialCapital);
    $('total-pnl').textContent = fmtUsd(risk.totalPnl);
    $('total-pnl').className = 'value ' + (risk.totalPnl >= 0 ? 'green' : 'red');
    const pnlPct = status.initialCapital > 0 ? pnl / status.initialCapital : 0;
    $('pnl-pct').textContent = fmtPct(pnlPct) + ' return';
    $('win-rate').textContent = risk.totalTrades > 0 ? fmtPct(risk.winRate) : '-';
    $('win-rate').className = 'value ' + (risk.winRate >= 0.5 ? 'green' : risk.totalTrades > 0 ? 'yellow' : '');
    $('trade-count').textContent = risk.totalTrades + ' trades';
    $('open-count').textContent = positions.length;
    $('symbols-tracked').textContent = status.symbols.join(', ');

    // Prices (enriched with HL data)
    const pg = $('prices-grid');
    const symbols = Object.keys(prices);
    if (symbols.length === 0) {
      pg.innerHTML = '<div class="empty-state">No data yet</div>';
    } else {
      pg.innerHTML = symbols.map(s => {
        const p = prices[s];
        const fr = p.fundingRate;
        const frClass = fr > 0 ? 'green' : fr < 0 ? 'red' : '';
        const change24h = p.prevDayPx ? ((p.price - p.prevDayPx) / p.prevDayPx * 100) : null;
        const changeClass = change24h !== null ? (change24h >= 0 ? 'green' : 'red') : '';
        const vol = p.dayVolume ? (p.dayVolume > 1e6 ? (p.dayVolume/1e6).toFixed(1) + 'M' : p.dayVolume.toFixed(0)) : '-';
        const oi = p.openInterest ? (p.openInterest > 1e6 ? (p.openInterest/1e6).toFixed(1) + 'M' : p.openInterest.toFixed(0)) : '-';
        return '<div class="price-card">' +
          '<div class="symbol">' + s + (change24h !== null ? ' <span class="' + changeClass + '" style="font-size:12px">' + (change24h >= 0 ? '+' : '') + change24h.toFixed(2) + '%</span>' : '') + '</div>' +
          '<div class="price">$' + p.price.toLocaleString(undefined,{maximumFractionDigits:2}) + '</div>' +
          '<div class="funding ' + frClass + '">Funding: ' + (fr !== null ? (fr * 100).toFixed(4) + '%' : 'N/A') + '</div>' +
          '<div style="font-size:11px;color:#64748b;margin-top:4px">Vol: $' + vol + ' | OI: $' + oi + '</div>' +
          '</div>';
      }).join('');
    }

    // Positions
    const pl = $('positions-list');
    if (positions.length === 0) {
      pl.innerHTML = '<div class="empty-state">No open positions</div>';
    } else {
      pl.innerHTML = positions.map(p => {
        const pnlClass = p.unrealizedPnl >= 0 ? 'green' : 'red';
        return '<div class="pos-card ' + p.side + '">' +
          '<div class="pos-header">' +
            '<span><strong>' + p.side.toUpperCase() + '</strong> ' + p.symbol + ' (' + p.strategy + ')</span>' +
            '<span class="' + pnlClass + '">' + fmtUsd(p.unrealizedPnl) + '</span>' +
          '</div>' +
          '<div class="pos-details">' +
            '<div><div class="label">Entry</div>$' + p.entryPrice.toFixed(2) + '</div>' +
            '<div><div class="label">Current</div>$' + p.currentPrice.toFixed(2) + '</div>' +
            '<div><div class="label">Size</div>' + fmtUsd(p.sizeUsd) + '</div>' +
            '<div><div class="label">Leverage</div>' + p.leverage + 'x</div>' +
            '<div><div class="label">Stop Loss</div>$' + p.stopLoss.toFixed(2) + '</div>' +
            '<div><div class="label">Take Profit</div>$' + p.takeProfit.toFixed(2) + '</div>' +
            '<div><div class="label">Trailing</div>' + (p.trailingStop ? '$' + p.trailingStop.toFixed(2) : '-') + '</div>' +
            '<div><div class="label">Liq. Price</div>$' + p.liquidationPrice.toFixed(2) + '</div>' +
          '</div>' +
          '</div>';
      }).join('');
    }

    // Trades table
    const tb = $('trades-body');
    const closeTrades = trades.filter(t => t.action !== 'open').reverse().slice(0, 50);
    if (closeTrades.length === 0) {
      tb.innerHTML = '<tr><td colspan="9" class="empty-state">No trades yet</td></tr>';
    } else {
      tb.innerHTML = closeTrades.map(t => {
        const pnlClass = t.pnl >= 0 ? 'green' : 'red';
        return '<tr>' +
          '<td>' + fmtTime(t.timestamp) + '</td>' +
          '<td>' + t.symbol + '</td>' +
          '<td class="' + (t.side === 'long' ? 'green' : 'red') + '">' + t.side.toUpperCase() + '</td>' +
          '<td>' + t.action + '</td>' +
          '<td>$' + t.price.toFixed(2) + '</td>' +
          '<td>' + fmtUsd(t.sizeUsd) + '</td>' +
          '<td>' + t.leverage + 'x</td>' +
          '<td class="' + pnlClass + '">' + fmtUsd(t.pnl) + '</td>' +
          '<td>' + t.strategy + '</td>' +
          '</tr>';
      }).join('');
    }

    // Risk & Performance
    $('r-max-risk').textContent = fmtPct(risk.maxRiskPerTrade);
    $('r-max-daily').textContent = fmtPct(risk.maxDailyLoss);
    $('r-max-lev').textContent = risk.maxLeverage + 'x';
    $('r-avg-win').textContent = risk.avgWin > 0 ? fmtUsd(risk.avgWin) : '-';
    $('r-avg-loss').textContent = risk.avgLoss < 0 ? fmtUsd(risk.avgLoss) : '-';
    $('r-best').textContent = risk.bestTrade > 0 ? fmtUsd(risk.bestTrade) : '-';
    $('r-worst').textContent = risk.worstTrade < 0 ? fmtUsd(risk.worstTrade) : '-';
    $('r-pf').textContent = risk.profitFactor === Infinity ? '∞' : (risk.profitFactor > 0 ? risk.profitFactor.toFixed(2) : '-');
    $('r-fees').textContent = risk.totalFees > 0 ? fmtUsd(risk.totalFees) : '-';
    $('cb-status').textContent = risk.circuitBreaker ? 'TRIPPED' : 'OK';
    $('cb-status').className = 'value ' + (risk.circuitBreaker ? 'red' : 'green');

    // Hyperliquid Account
    if (account.connected) {
      $('hl-connection').textContent = 'Connected';
      $('hl-connection').className = 'sub green';
      $('hl-account-value').textContent = '$' + parseFloat(account.accountValue).toFixed(2);
      $('hl-margin-used').textContent = '$' + parseFloat(account.totalMarginUsed).toFixed(2);
      $('hl-ntl-pos').textContent = 'Net position: $' + parseFloat(account.totalNtlPos).toFixed(2);
      $('hl-withdrawable').textContent = '$' + parseFloat(account.withdrawable).toFixed(2);
      const hlPos = account.onChainPositions || [];
      $('hl-positions-count').textContent = hlPos.length;
      $('hl-positions-list').textContent = hlPos.length > 0
        ? hlPos.map(p => p.coin + ': ' + p.size).join(', ')
        : 'No on-chain positions';
    } else {
      $('hl-connection').textContent = 'Not connected';
      $('hl-connection').className = 'sub red';
    }

    // Equity chart
    drawChart(equity);

  } catch (e) {
    console.error('Update failed:', e);
  }
}

function drawChart(data) {
  const canvas = $('equity-chart');
  if (!canvas || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px';
  canvas.style.height = rect.height + 'px';
  ctx.scale(dpr, dpr);

  const W = rect.width;
  const H = rect.height;
  const pad = { top: 20, right: 60, bottom: 30, left: 10 };
  const cw = W - pad.left - pad.right;
  const ch = H - pad.top - pad.bottom;

  const vals = data.map(d => d.equity);
  const min = Math.min(...vals) * 0.998;
  const max = Math.max(...vals) * 1.002;
  const range = max - min || 1;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ch * (1 - i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(W - pad.right, y); ctx.stroke();
    ctx.fillStyle = '#475569';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.fillText('$' + (min + range * i / 4).toFixed(0), W - 5, y + 4);
  }

  // Line
  const initial = data[0].equity;
  const final = data[data.length - 1].equity;
  const lineColor = final >= initial ? '#22c55e' : '#ef4444';

  ctx.beginPath();
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (let i = 0; i < data.length; i++) {
    const x = pad.left + (i / (data.length - 1)) * cw;
    const y = pad.top + ch * (1 - (data[i].equity - min) / range);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Fill beneath
  ctx.lineTo(pad.left + cw, pad.top + ch);
  ctx.lineTo(pad.left, pad.top + ch);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + ch);
  grad.addColorStop(0, lineColor + '30');
  grad.addColorStop(1, lineColor + '05');
  ctx.fillStyle = grad;
  ctx.fill();
}

// Initial load + auto refresh
update();
setInterval(update, 5000);
</script>
</body>
</html>`;
}
