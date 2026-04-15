import { TradeSignal, Position, OHLCV } from '../utils/types';
import { RiskConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { clamp } from '../utils/helpers';

export class RiskManager {
  private config: RiskConfig;
  private totalCapital: number;
  private dailyPnl: number = 0;
  private dailyTradeCount: number = 0;
  private lastResetDate: string = '';
  private circuitBreakerTripped: boolean = false;

  constructor(config: RiskConfig, totalCapital: number) {
    this.config = config;
    this.totalCapital = totalCapital;
  }

  /**
   * Validate and size a trade signal based on risk parameters.
   * Returns the signal with leverage and position size filled in, or null if rejected.
   */
  validateSignal(signal: TradeSignal, openPositions: Position[]): TradeSignal | null {
    this.resetDailyIfNeeded();

    // Circuit breaker check
    if (this.circuitBreakerTripped) {
      logger.warn('RISK: Circuit breaker tripped. No new trades.');
      return null;
    }

    // Daily loss limit
    if (this.dailyPnl <= -this.totalCapital * this.config.maxDailyLoss) {
      this.circuitBreakerTripped = true;
      logger.warn(
        `RISK: Daily loss limit reached (${this.dailyPnl.toFixed(2)}). Circuit breaker tripped.`
      );
      return null;
    }

    // Max concurrent positions
    const activePositions = openPositions.filter((p) => p.status === 'open');
    if (activePositions.length >= this.config.maxConcurrentPositions) {
      logger.warn(`RISK: Max concurrent positions reached (${this.config.maxConcurrentPositions})`);
      return null;
    }

    // Don't open opposing positions in same symbol
    const sameSymbolPositions = activePositions.filter(
      (p) => p.symbol === signal.symbol && p.side !== signal.side
    );
    if (sameSymbolPositions.length > 0) {
      logger.warn('RISK: Opposing position already open for this symbol');
      return null;
    }

    // Confidence threshold — higher bar reduces trade frequency but improves quality
    if (signal.confidence < this.config.confidenceThreshold) {
      logger.debug(`RISK: Signal confidence too low (${signal.confidence.toFixed(2)} < ${this.config.confidenceThreshold})`);
      return null;
    }

    // Calculate position size based on risk
    const positionSize = this.calculatePositionSize(signal);
    if (positionSize <= 0) {
      logger.warn('RISK: Calculated position size is 0');
      return null;
    }

    // Determine leverage
    const leverage = this.calculateLeverage(signal);

    return {
      ...signal,
      positionSizeUsd: positionSize,
      leverage,
    };
  }

  /**
   * ATR-based position sizing: risk a fixed % of capital per trade.
   * Position size = (Capital * MaxRisk%) / (ATR * multiplier)
   */
  calculatePositionSize(signal: TradeSignal): number {
    const riskAmount = this.totalCapital * this.config.maxRiskPerTrade;

    // Risk per unit = distance from entry to stop loss
    const riskPerUnit = Math.abs(signal.entryPrice - signal.stopLoss);
    if (riskPerUnit === 0) return 0;

    // Position size in USD
    const positionSize = (riskAmount / riskPerUnit) * signal.entryPrice;

    // Cap at 30% of total capital per position
    const maxPositionSize = this.totalCapital * 0.3;

    return Math.min(positionSize, maxPositionSize);
  }

  /**
   * Calculate appropriate leverage based on volatility and confidence.
   */
  calculateLeverage(signal: TradeSignal): number {
    const atr = (signal.metadata?.atr as number) || 0;
    const currentPrice = signal.entryPrice;

    // Volatility-based leverage: lower leverage for higher volatility
    let leverage = this.config.defaultLeverage;

    if (atr > 0 && currentPrice > 0) {
      const volatilityPercent = atr / currentPrice;
      // Volatility-based leverage reduction (configurable thresholds)
      if (volatilityPercent > this.config.highVolThreshold) leverage = this.config.highVolLeverage;
      else if (volatilityPercent > this.config.medVolThreshold) leverage = this.config.medVolLeverage;
      else if (volatilityPercent > this.config.lowVolThreshold) leverage = this.config.lowVolLeverage;
      else leverage = this.config.minVolLeverage;
    }

    // Scale by confidence
    leverage = leverage * clamp(signal.confidence, 0.5, 1.0);

    // Ensure within bounds
    leverage = clamp(Math.round(leverage), 1, this.config.maxLeverage);

    return leverage;
  }

  /**
   * Calculate liquidation price for a position.
   */
  calculateLiquidationPrice(
    entryPrice: number,
    leverage: number,
    side: 'long' | 'short',
    maintenanceMargin: number = 0.005 // 0.5% typical for L2 perps
  ): number {
    if (side === 'long') {
      return entryPrice * (1 - 1 / leverage + maintenanceMargin);
    } else {
      return entryPrice * (1 + 1 / leverage - maintenanceMargin);
    }
  }

  /**
   * Check if any open positions should be closed (SL/TP/trailing/liquidation).
   */
  checkPositionExits(positions: Position[], currentPrices: Map<string, number>): Position[] {
    const positionsToClose: Position[] = [];

    for (const position of positions) {
      if (position.status !== 'open') continue;

      const currentPrice = currentPrices.get(position.symbol);
      if (!currentPrice) continue;

      position.currentPrice = currentPrice;
      position.unrealizedPnl = this.calculatePnl(position, currentPrice);

      // Update trailing stop
      if (position.trailingStop) {
        position.trailingStop = this.updateTrailingStop(position, currentPrice);
      }

      // Check stop loss
      if (this.isStopLossHit(position, currentPrice)) {
        logger.warn(
          `RISK: Stop loss hit for ${position.symbol} ${position.side} @ $${currentPrice}`
        );
        positionsToClose.push(position);
        continue;
      }

      // Check take profit
      if (this.isTakeProfitHit(position, currentPrice)) {
        logger.info(
          `RISK: Take profit hit for ${position.symbol} ${position.side} @ $${currentPrice}`
        );
        positionsToClose.push(position);
        continue;
      }

      // Check trailing stop
      if (position.trailingStop && this.isTrailingStopHit(position, currentPrice)) {
        logger.info(
          `RISK: Trailing stop hit for ${position.symbol} ${position.side} @ $${currentPrice}`
        );
        positionsToClose.push(position);
        continue;
      }

      // Check liquidation proximity (warn at 80% to liquidation)
      const distToLiq = Math.abs(currentPrice - position.liquidationPrice) / currentPrice;
      if (distToLiq < 0.02) {
        logger.error(
          `RISK: Position ${position.symbol} is near liquidation! ` +
            `Price: $${currentPrice}, Liq: $${position.liquidationPrice}`
        );
        positionsToClose.push(position);
      }
    }

    return positionsToClose;
  }

  private isStopLossHit(position: Position, price: number): boolean {
    if (position.side === 'long') return price <= position.stopLoss;
    return price >= position.stopLoss;
  }

  private isTakeProfitHit(position: Position, price: number): boolean {
    if (position.side === 'long') return price >= position.takeProfit;
    return price <= position.takeProfit;
  }

  private isTrailingStopHit(position: Position, price: number): boolean {
    if (!position.trailingStop) return false;
    if (position.side === 'long') return price <= position.trailingStop;
    return price >= position.trailingStop;
  }

  private updateTrailingStop(position: Position, currentPrice: number): number {
    const trailPercent = this.config.trailingStopPercent;
    const currentTrail = position.trailingStop!;

    if (position.side === 'long') {
      const newTrail = currentPrice * (1 - trailPercent);
      return Math.max(currentTrail, newTrail); // Trail up only
    } else {
      const newTrail = currentPrice * (1 + trailPercent);
      return Math.min(currentTrail, newTrail); // Trail down only
    }
  }

  private calculatePnl(position: Position, currentPrice: number): number {
    const priceChange = position.side === 'long'
      ? currentPrice - position.entryPrice
      : position.entryPrice - currentPrice;
    return (priceChange / position.entryPrice) * position.sizeUsd * position.leverage;
  }

  recordTradePnl(pnl: number): void {
    this.resetDailyIfNeeded();
    this.dailyPnl += pnl;
    this.dailyTradeCount++;
    logger.info(
      `RISK: Trade PnL: $${pnl.toFixed(2)}, Daily PnL: $${this.dailyPnl.toFixed(2)}, ` +
        `Trades today: ${this.dailyTradeCount}`
    );
  }

  updateCapital(newCapital: number): void {
    this.totalCapital = newCapital;
  }

  getCapital(): number {
    return this.totalCapital;
  }

  isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  resetCircuitBreaker(): void {
    this.circuitBreakerTripped = false;
    logger.info('RISK: Circuit breaker reset');
  }

  getRiskConfig(): RiskConfig {
    return { ...this.config };
  }

  updateRiskConfig(partial: Partial<RiskConfig>): void {
    Object.assign(this.config, partial);
    logger.info(`RISK: Config updated: ${JSON.stringify(partial)}`);
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyPnl = 0;
      this.dailyTradeCount = 0;
      this.lastResetDate = today;
      this.circuitBreakerTripped = false;
      logger.info('RISK: Daily counters reset');
    }
  }
}
