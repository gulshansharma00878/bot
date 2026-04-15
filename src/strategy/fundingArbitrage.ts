import { BaseStrategy } from './base';
import { TradeSignal, StrategyParams, MarketState } from '../utils/types';
import { logger } from '../utils/logger';

/**
 * Funding Rate Arbitrage Strategy
 * - When funding rate is highly positive → short (longs are paying shorts)
 * - When funding rate is highly negative → long (shorts are paying longs)
 * - Collect funding while being delta-neutral or directionally aligned
 * - Minimum holding period to collect at least one funding payment
 */
export class FundingArbitrageStrategy extends BaseStrategy {
  name = 'funding_arbitrage' as const;
  params: StrategyParams;

  constructor(params?: Partial<StrategyParams>) {
    super();
    this.params = {
      fundingThreshold: params?.fundingThreshold ?? 0.0005, // 0.05% threshold
      minHoldingPeriodHours: params?.minHoldingPeriodHours ?? 8,
    };
  }

  analyze(state: MarketState): TradeSignal | null {
    if (!state.fundingRate) {
      logger.debug('FundingArbitrage: No funding rate data');
      return null;
    }

    const candles1h = state.candles['1h'];
    if (!candles1h || candles1h.length < 20) {
      logger.debug('FundingArbitrage: Insufficient candle data');
      return null;
    }

    const fundingRate = state.fundingRate.rate;
    const threshold = this.params.fundingThreshold!;

    // Check if funding rate is extreme enough to trade
    if (Math.abs(fundingRate) < threshold) {
      return null;
    }

    const closes = candles1h.map((c) => c.close);
    const atr = this.calcATR(candles1h, 14);
    const currentPrice = closes[closes.length - 1];
    const currentATR = atr[atr.length - 1];

    // High positive funding → short (we collect funding from longs)
    // High negative funding → long (we collect funding from shorts)
    const side = fundingRate > 0 ? 'short' : 'long';

    // Check OI imbalance for additional confirmation
    let oiConfirmed = true;
    if (state.openInterest) {
      const { longOI, shortOI } = state.openInterest;
      const ratio = longOI / (shortOI || 1);
      // When funding is positive, we expect more longs (ratio > 1)
      if (fundingRate > 0 && ratio < 0.9) oiConfirmed = false;
      if (fundingRate < 0 && ratio > 1.1) oiConfirmed = false;
    }

    if (!oiConfirmed) {
      logger.debug('FundingArbitrage: OI imbalance does not confirm signal');
      return null;
    }

    // Use wider stops for funding arb (we want to hold through volatility)
    const atrMultiple = 3;
    const stopLoss =
      side === 'long'
        ? currentPrice - atrMultiple * currentATR
        : currentPrice + atrMultiple * currentATR;
    const takeProfit =
      side === 'long'
        ? currentPrice + 2 * currentATR
        : currentPrice - 2 * currentATR;

    // Confidence based on funding rate magnitude
    const fundingMagnitude = Math.abs(fundingRate) / threshold;
    const confidence = Math.min(0.8, 0.3 + fundingMagnitude * 0.15);

    // Expected funding income per 8h period
    const expectedFundingReturn = Math.abs(fundingRate); // as a fraction of position

    const signal: TradeSignal = {
      strategy: this.name,
      symbol: state.symbol,
      side,
      confidence,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      leverage: 0,
      positionSizeUsd: 0,
      timestamp: Date.now(),
      metadata: {
        fundingRate,
        fundingMagnitude,
        expectedFundingReturn,
        atr: currentATR,
        minHoldingHours: this.params.minHoldingPeriodHours,
      },
    };

    logger.info(
      `FundingArbitrage SIGNAL: ${side.toUpperCase()} ${state.symbol} @ $${currentPrice.toFixed(2)} ` +
        `(funding: ${(fundingRate * 100).toFixed(4)}%, confidence: ${(confidence * 100).toFixed(1)}%)`
    );

    return signal;
  }
}
