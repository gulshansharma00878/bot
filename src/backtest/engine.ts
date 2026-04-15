import { OHLCV, TradeSignal, TradeLog, BacktestResult, Position, MarketState, StrategyName, FundingRate, Timeframe } from '../utils/types';
import { RiskConfig } from '../utils/config';
import { StrategyEngine, TrendFollowingStrategy, MeanReversionStrategy, FundingArbitrageStrategy } from '../strategy';
import { RiskManager } from '../risk/manager';
import { generateId } from '../utils/helpers';
import { logger } from '../utils/logger';

export interface BacktestConfig {
  initialCapital: number;
  strategy: StrategyName;
  symbol: string;
  candles: OHLCV[];
  fundingRates?: FundingRate[];
  risk: RiskConfig;
  slippageBps?: number; // Basis points of slippage per trade
  feesBps?: number;     // Trading fees in basis points
}

export class BacktestEngine {
  private config: BacktestConfig;
  private strategyEngine: StrategyEngine;
  private riskManager: RiskManager;
  private capital: number;
  private peakCapital: number;
  private positions: Position[] = [];
  private openPosition: Position | null = null;
  private trades: TradeLog[] = [];
  private equityCurve: { timestamp: number; equity: number }[] = [];

  constructor(config: BacktestConfig) {
    this.config = config;
    this.capital = config.initialCapital;
    this.peakCapital = config.initialCapital;
    this.strategyEngine = new StrategyEngine(config.strategy);
    this.riskManager = new RiskManager(config.risk, config.initialCapital);
  }

  run(): BacktestResult {
    const { candles, symbol, fundingRates } = this.config;
    const slippageBps = this.config.slippageBps ?? 5;
    const feesBps = this.config.feesBps ?? 10;

    logger.info(
      `Backtest starting: ${this.config.strategy} on ${symbol}, ` +
        `${candles.length} candles, capital: $${this.capital}`
    );

    // We need at least 50 candles to have enough indicator warmup
    const warmupPeriod = 50;

    for (let i = warmupPeriod; i < candles.length; i++) {
      const currentCandle = candles[i];
      const currentPrice = currentCandle.close;

      // Build market state from available candles up to current index
      const candlesUpToNow = candles.slice(0, i + 1);

      // Create multi-timeframe views
      const candles1h = candlesUpToNow.slice(-200);
      const candles4h = this.resampleToHigherTF(candlesUpToNow, 4);
      const candles1d = this.resampleToHigherTF(candlesUpToNow, 24);

      // Find nearest funding rate
      let fundingRate: FundingRate | undefined;
      if (fundingRates) {
        fundingRate = fundingRates.reduce((prev, curr) =>
          Math.abs(curr.timestamp - currentCandle.timestamp) <
          Math.abs(prev.timestamp - currentCandle.timestamp)
            ? curr
            : prev
        );
      }

      const state: MarketState = {
        symbol,
        price: {
          symbol,
          price: currentPrice,
          timestamp: currentCandle.timestamp,
          source: 'backtest',
        },
        fundingRate,
        candles: {
          '1m': [],
          '5m': [],
          '15m': [],
          '1h': candles1h,
          '4h': candles4h,
          '1d': candles1d,
        },
      };

      // Check exits for open position
      if (this.openPosition) {
        const exitReason = this.checkExit(this.openPosition, currentCandle);
        if (exitReason) {
          const exitPrice = this.getExitPrice(
            this.openPosition, currentCandle, exitReason, slippageBps
          );
          this.closeBacktestPosition(exitPrice, exitReason, currentCandle.timestamp);
        }
      }

      // Generate signal if no open position
      if (!this.openPosition) {
        const signal = this.strategyEngine.analyze(state);
        if (signal) {
          const validatedSignal = this.riskManager.validateSignal(signal, this.positions);
          if (validatedSignal) {
            // Apply slippage to entry
            const slippage = currentPrice * (slippageBps / 10000);
            const entryPrice =
              validatedSignal.side === 'long'
                ? currentPrice + slippage
                : currentPrice - slippage;

            this.openBacktestPosition(validatedSignal, entryPrice, currentCandle.timestamp);
          }
        }
      }

      // Accumulate funding for open positions
      if (this.openPosition && fundingRate) {
        this.applyFunding(this.openPosition, fundingRate);
      }

      // Record equity curve
      const equity = this.calculateEquity(currentPrice);
      this.equityCurve.push({ timestamp: currentCandle.timestamp, equity });

      // Update peak for drawdown tracking
      if (equity > this.peakCapital) {
        this.peakCapital = equity;
      }
    }

    // Close any remaining open position at last price
    if (this.openPosition && candles.length > 0) {
      const lastPrice = candles[candles.length - 1].close;
      this.closeBacktestPosition(lastPrice, 'close', candles[candles.length - 1].timestamp);
    }

    return this.generateResults();
  }

  private openBacktestPosition(
    signal: TradeSignal,
    entryPrice: number,
    timestamp: number
  ): void {
    const position: Position = {
      id: generateId(),
      symbol: signal.symbol,
      side: signal.side,
      entryPrice,
      currentPrice: entryPrice,
      size: signal.positionSizeUsd / entryPrice,
      sizeUsd: signal.positionSizeUsd,
      leverage: signal.leverage,
      liquidationPrice:
        signal.side === 'long'
          ? entryPrice * (1 - 1 / signal.leverage + 0.005)
          : entryPrice * (1 + 1 / signal.leverage - 0.005),
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      trailingStop: signal.side === 'long'
        ? entryPrice * (1 - this.config.risk.trailingStopPercent)
        : entryPrice * (1 + this.config.risk.trailingStopPercent),
      unrealizedPnl: 0,
      realizedPnl: 0,
      status: 'open',
      openTime: timestamp,
      strategy: signal.strategy,
    };

    this.openPosition = position;
    this.positions.push(position);

    // Opening fee
    const fee = position.sizeUsd * (this.config.feesBps ?? 10) / 10000;
    this.capital -= fee;

    this.trades.push({
      id: generateId(),
      timestamp,
      symbol: signal.symbol,
      side: signal.side,
      action: 'open',
      price: entryPrice,
      size: position.size,
      sizeUsd: position.sizeUsd,
      leverage: signal.leverage,
      pnl: 0,
      fees: fee,
      strategy: signal.strategy,
    });
  }

  private closeBacktestPosition(
    exitPrice: number,
    reason: string,
    timestamp: number
  ): void {
    if (!this.openPosition) return;

    const pos = this.openPosition;
    const priceChange =
      pos.side === 'long' ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
    const pnlPercent = priceChange / pos.entryPrice;
    const fee = pos.sizeUsd * (this.config.feesBps ?? 10) / 10000;
    const pnl = pnlPercent * pos.sizeUsd * pos.leverage - fee;

    pos.realizedPnl = pnl;
    pos.currentPrice = exitPrice;
    pos.status = reason === 'liquidated' ? 'liquidated' : 'closed';
    pos.closeTime = timestamp;

    this.capital += pnl;
    this.riskManager.recordTradePnl(pnl);
    this.riskManager.updateCapital(this.capital);

    this.trades.push({
      id: generateId(),
      timestamp,
      symbol: pos.symbol,
      side: pos.side,
      action: reason as TradeLog['action'],
      price: exitPrice,
      size: pos.size,
      sizeUsd: pos.sizeUsd,
      leverage: pos.leverage,
      pnl,
      fees: fee,
      strategy: pos.strategy,
    });

    this.openPosition = null;
  }

  private checkExit(
    position: Position,
    candle: OHLCV
  ): string | null {
    // Check liquidation
    if (position.side === 'long' && candle.low <= position.liquidationPrice) {
      return 'liquidated';
    }
    if (position.side === 'short' && candle.high >= position.liquidationPrice) {
      return 'liquidated';
    }

    // Check stop loss
    if (position.side === 'long' && candle.low <= position.stopLoss) {
      return 'stop_loss';
    }
    if (position.side === 'short' && candle.high >= position.stopLoss) {
      return 'stop_loss';
    }

    // Check take profit
    if (position.side === 'long' && candle.high >= position.takeProfit) {
      return 'take_profit';
    }
    if (position.side === 'short' && candle.low <= position.takeProfit) {
      return 'take_profit';
    }

    // Update and check trailing stop
    if (position.trailingStop) {
      if (position.side === 'long') {
        const newTrail = candle.high * (1 - this.config.risk.trailingStopPercent);
        position.trailingStop = Math.max(position.trailingStop, newTrail);
        if (candle.low <= position.trailingStop) {
          return 'trailing_stop';
        }
      } else {
        const newTrail = candle.low * (1 + this.config.risk.trailingStopPercent);
        position.trailingStop = Math.min(position.trailingStop, newTrail);
        if (candle.high >= position.trailingStop) {
          return 'trailing_stop';
        }
      }
    }

    return null;
  }

  private getExitPrice(
    position: Position,
    candle: OHLCV,
    reason: string,
    slippageBps: number
  ): number {
    const slippage = candle.close * (slippageBps / 10000);

    switch (reason) {
      case 'stop_loss':
        // Assume filled at stop loss price (may be worse in reality)
        return position.side === 'long'
          ? position.stopLoss - slippage
          : position.stopLoss + slippage;
      case 'take_profit':
        return position.side === 'long'
          ? position.takeProfit - slippage
          : position.takeProfit + slippage;
      case 'trailing_stop':
        return position.side === 'long'
          ? position.trailingStop! - slippage
          : position.trailingStop! + slippage;
      case 'liquidated':
        return position.liquidationPrice;
      default:
        return position.side === 'long'
          ? candle.close - slippage
          : candle.close + slippage;
    }
  }

  private applyFunding(position: Position, funding: FundingRate): void {
    // If long and funding > 0, you pay; if short and funding > 0, you receive
    const fundingPnl =
      position.side === 'long'
        ? -funding.rate * position.sizeUsd
        : funding.rate * position.sizeUsd;
    this.capital += fundingPnl;
  }

  private calculateEquity(currentPrice: number): number {
    let equity = this.capital;
    if (this.openPosition) {
      const priceChange =
        this.openPosition.side === 'long'
          ? currentPrice - this.openPosition.entryPrice
          : this.openPosition.entryPrice - currentPrice;
      const unrealizedPnl =
        (priceChange / this.openPosition.entryPrice) *
        this.openPosition.sizeUsd *
        this.openPosition.leverage;
      equity += unrealizedPnl;
    }
    return equity;
  }

  private resampleToHigherTF(candles: OHLCV[], multiplier: number): OHLCV[] {
    if (candles.length < multiplier) return candles;

    const resampled: OHLCV[] = [];
    for (let i = 0; i < candles.length; i += multiplier) {
      const group = candles.slice(i, Math.min(i + multiplier, candles.length));
      if (group.length === 0) break;

      resampled.push({
        timestamp: group[0].timestamp,
        open: group[0].open,
        high: Math.max(...group.map((c) => c.high)),
        low: Math.min(...group.map((c) => c.low)),
        close: group[group.length - 1].close,
        volume: group.reduce((s, c) => s + c.volume, 0),
      });
    }
    return resampled;
  }

  private generateResults(): BacktestResult {
    const closedTrades = this.trades.filter((t) => t.action !== 'open');
    const wins = closedTrades.filter((t) => t.pnl > 0);
    const losses = closedTrades.filter((t) => t.pnl <= 0);

    const totalPnl = this.capital - this.config.initialCapital;
    const totalPnlPercent = totalPnl / this.config.initialCapital;

    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss =
      losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    const profitFactor =
      losses.length > 0 && avgLoss > 0
        ? (wins.reduce((s, t) => s + t.pnl, 0)) /
          Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
        : wins.length > 0
        ? Infinity
        : 0;

    // Calculate max drawdown
    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    let peak = this.config.initialCapital;
    for (const point of this.equityCurve) {
      if (point.equity > peak) peak = point.equity;
      const dd = peak - point.equity;
      const ddPercent = dd / peak;
      if (dd > maxDrawdown) maxDrawdown = dd;
      if (ddPercent > maxDrawdownPercent) maxDrawdownPercent = ddPercent;
    }

    // Calculate Sharpe ratio (annualized, assuming 4h candles → ~2190 per year)
    const returns: number[] = [];
    for (let i = 1; i < this.equityCurve.length; i++) {
      const ret =
        (this.equityCurve[i].equity - this.equityCurve[i - 1].equity) /
        this.equityCurve[i - 1].equity;
      returns.push(ret);
    }
    const meanReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
    const stdReturn =
      returns.length > 1
        ? Math.sqrt(
            returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1)
          )
        : 0;
    const periodsPerYear = 2190; // ~4h candles
    const sharpeRatio =
      stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(periodsPerYear) : 0;

    // Average holding period
    const holdingPeriods = this.positions
      .filter((p) => p.closeTime)
      .map((p) => (p.closeTime! - p.openTime) / (3600 * 1000));
    const avgHoldingHours =
      holdingPeriods.length > 0
        ? holdingPeriods.reduce((s, h) => s + h, 0) / holdingPeriods.length
        : 0;

    const startDate = this.config.candles.length > 0
      ? new Date(this.config.candles[0].timestamp).toISOString().slice(0, 10)
      : 'N/A';
    const endDate = this.config.candles.length > 0
      ? new Date(this.config.candles[this.config.candles.length - 1].timestamp).toISOString().slice(0, 10)
      : 'N/A';

    return {
      strategy: this.config.strategy,
      symbol: this.config.symbol,
      startDate,
      endDate,
      initialCapital: this.config.initialCapital,
      finalCapital: this.capital,
      totalPnl,
      totalPnlPercent,
      totalTrades: closedTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      winRate: closedTrades.length > 0 ? wins.length / closedTrades.length : 0,
      avgWin,
      avgLoss,
      profitFactor,
      sharpeRatio,
      maxDrawdown,
      maxDrawdownPercent,
      avgHoldingPeriodHours: avgHoldingHours,
      trades: this.trades,
      equityCurve: this.equityCurve,
    };
  }
}
