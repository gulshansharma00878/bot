import * as fs from 'fs';
import * as path from 'path';
import { createObjectCsvWriter } from 'csv-writer';
import { BacktestEngine, BacktestConfig } from './engine';
import { fetchHistoricalOHLCV, generateHistoricalFunding } from '../data/feeds';
import { BacktestResult, StrategyName } from '../utils/types';
import { RiskConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { loadConfig } from '../utils/config';

const RESULTS_DIR = path.join(process.cwd(), 'backtest_results');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function exportToCsv(result: BacktestResult, filename: string): Promise<void> {
  ensureDir(RESULTS_DIR);

  // Trade log CSV
  const tradeCsvWriter = createObjectCsvWriter({
    path: path.join(RESULTS_DIR, `${filename}_trades.csv`),
    header: [
      { id: 'timestamp', title: 'Timestamp' },
      { id: 'symbol', title: 'Symbol' },
      { id: 'side', title: 'Side' },
      { id: 'action', title: 'Action' },
      { id: 'price', title: 'Price' },
      { id: 'sizeUsd', title: 'Size (USD)' },
      { id: 'leverage', title: 'Leverage' },
      { id: 'pnl', title: 'PnL' },
      { id: 'fees', title: 'Fees' },
    ],
  });

  await tradeCsvWriter.writeRecords(
    result.trades.map((t) => ({
      ...t,
      timestamp: new Date(t.timestamp).toISOString(),
      price: t.price.toFixed(2),
      sizeUsd: t.sizeUsd.toFixed(2),
      pnl: t.pnl.toFixed(2),
      fees: t.fees.toFixed(2),
    }))
  );

  // Equity curve CSV
  const equityCsvWriter = createObjectCsvWriter({
    path: path.join(RESULTS_DIR, `${filename}_equity.csv`),
    header: [
      { id: 'timestamp', title: 'Timestamp' },
      { id: 'equity', title: 'Equity' },
    ],
  });

  // Downsample equity curve to manageable size
  const step = Math.max(1, Math.floor(result.equityCurve.length / 1000));
  const downsampled = result.equityCurve.filter((_, i) => i % step === 0);

  await equityCsvWriter.writeRecords(
    downsampled.map((e) => ({
      timestamp: new Date(e.timestamp).toISOString(),
      equity: e.equity.toFixed(2),
    }))
  );

  logger.info(`CSV exported to ${RESULTS_DIR}/${filename}_*.csv`);
}

function printResults(result: BacktestResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('          BACKTEST RESULTS');
  console.log('='.repeat(60));
  console.log(`Strategy:           ${result.strategy}`);
  console.log(`Symbol:             ${result.symbol}`);
  console.log(`Period:             ${result.startDate} → ${result.endDate}`);
  console.log('-'.repeat(60));
  console.log(`Initial Capital:    $${result.initialCapital.toLocaleString()}`);
  console.log(`Final Capital:      $${result.finalCapital.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`Total PnL:          $${result.totalPnl.toFixed(2)} (${(result.totalPnlPercent * 100).toFixed(2)}%)`);
  console.log('-'.repeat(60));
  console.log(`Total Trades:       ${result.totalTrades}`);
  console.log(`Win Rate:           ${(result.winRate * 100).toFixed(1)}%`);
  console.log(`Avg Win:            $${result.avgWin.toFixed(2)}`);
  console.log(`Avg Loss:           $${result.avgLoss.toFixed(2)}`);
  console.log(`Profit Factor:      ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
  console.log('-'.repeat(60));
  console.log(`Sharpe Ratio:       ${result.sharpeRatio.toFixed(2)}`);
  console.log(`Max Drawdown:       $${result.maxDrawdown.toFixed(2)} (${(result.maxDrawdownPercent * 100).toFixed(2)}%)`);
  console.log(`Avg Holding Period: ${result.avgHoldingPeriodHours.toFixed(1)} hours`);
  console.log('='.repeat(60));

  // Render simple ASCII equity chart
  renderAsciiChart(result);
}

function renderAsciiChart(result: BacktestResult): void {
  const curve = result.equityCurve;
  if (curve.length < 2) return;

  const width = 60;
  const height = 20;
  const step = Math.max(1, Math.floor(curve.length / width));
  const sampled = curve.filter((_, i) => i % step === 0).slice(0, width);
  const values = sampled.map((p) => p.equity);

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  console.log('\n  EQUITY CURVE:');
  console.log('  ' + '-'.repeat(width + 2));

  for (let row = height - 1; row >= 0; row--) {
    const threshold = min + (range * row) / (height - 1);
    let line = '  |';
    for (const val of values) {
      line += val >= threshold ? '█' : ' ';
    }
    line += '|';
    if (row === height - 1) line += ` $${max.toFixed(0)}`;
    if (row === 0) line += ` $${min.toFixed(0)}`;
    console.log(line);
  }

  console.log('  ' + '-'.repeat(width + 2));
  console.log(`  ${result.startDate}${' '.repeat(width - 20)}${result.endDate}`);
}

async function runBacktest(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch {
    // Use defaults if .env not set
    config = null;
  }

  const strategies: StrategyName[] = ['trend_following', 'mean_reversion', 'funding_arbitrage'];
  const symbol = 'ETH';
  const initialCapital = config?.tradingCapitalUsd ?? 10000;

  const riskConfig: RiskConfig = config?.risk ?? {
    maxRiskPerTrade: 0.02,
    maxDailyLoss: 0.05,
    maxLeverage: 10,
    defaultLeverage: 3,
    stopLossPercent: 0.03,
    takeProfitPercent: 0.06,
    trailingStopPercent: 0.02,
    confidenceThreshold: 0.55,
    maxConcurrentPositions: 5,
    highVolThreshold: 0.05,
    highVolLeverage: 2,
    medVolThreshold: 0.03,
    medVolLeverage: 3,
    lowVolThreshold: 0.01,
    lowVolLeverage: 5,
    minVolLeverage: 7,
  };

  console.log('Fetching historical data...');
  let candles;
  try {
    candles = await fetchHistoricalOHLCV(symbol, 365);
  } catch (error) {
    logger.warn(`Could not fetch live data: ${error}. Generating synthetic data...`);
    candles = generateSyntheticData(365);
  }

  if (candles.length < 100) {
    logger.warn('Not enough live data. Generating synthetic data...');
    candles = generateSyntheticData(365);
  }

  const fundingRates = generateHistoricalFunding(candles, symbol);
  console.log(`Loaded ${candles.length} candles, ${fundingRates.length} funding snapshots.\n`);

  const allResults: BacktestResult[] = [];

  for (const strategy of strategies) {
    console.log(`\nRunning backtest for: ${strategy}...`);

    const backtestConfig: BacktestConfig = {
      initialCapital,
      strategy,
      symbol,
      candles,
      fundingRates,
      risk: riskConfig,
      slippageBps: 5,
      feesBps: 10,
    };

    const engine = new BacktestEngine(backtestConfig);
    const result = engine.run();
    allResults.push(result);

    printResults(result);

    const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    await exportToCsv(result, `${symbol}_${strategy}_${timestamp}`);
  }

  // Summary comparison
  console.log('\n' + '='.repeat(70));
  console.log('          STRATEGY COMPARISON');
  console.log('='.repeat(70));
  console.log(
    'Strategy'.padEnd(22) +
      'PnL%'.padEnd(10) +
      'Sharpe'.padEnd(10) +
      'MaxDD%'.padEnd(10) +
      'WinRate'.padEnd(10) +
      'Trades'
  );
  console.log('-'.repeat(70));
  for (const r of allResults) {
    console.log(
      r.strategy.padEnd(22) +
        `${(r.totalPnlPercent * 100).toFixed(1)}%`.padEnd(10) +
        r.sharpeRatio.toFixed(2).padEnd(10) +
        `${(r.maxDrawdownPercent * 100).toFixed(1)}%`.padEnd(10) +
        `${(r.winRate * 100).toFixed(1)}%`.padEnd(10) +
        r.totalTrades.toString()
    );
  }
  console.log('='.repeat(70));

  console.log(`\nResults exported to: ${RESULTS_DIR}/`);
}

function generateSyntheticData(days: number): any[] {
  const candles = [];
  const startTime = Date.now() - days * 24 * 3600 * 1000;
  let price = 2000 + Math.random() * 1000; // ETH-like starting price
  const candleInterval = 4 * 3600 * 1000; // 4h candles

  for (let i = 0; i < days * 6; i++) {
    const timestamp = startTime + i * candleInterval;
    const volatility = 0.02 + Math.random() * 0.03;
    const drift = (Math.random() - 0.48) * volatility; // Slight upward bias
    const change = price * drift;

    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + Math.random() * volatility * 0.5);
    const low = Math.min(open, close) * (1 - Math.random() * volatility * 0.5);
    const volume = 500_000_000 + Math.random() * 2_000_000_000;

    candles.push({ timestamp, open, high, low, close, volume });
    price = close;
  }

  return candles;
}

// Run if executed directly
runBacktest().catch((err) => {
  logger.error(`Backtest failed: ${err}`);
  process.exit(1);
});
