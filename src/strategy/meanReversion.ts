import { BaseStrategy } from './base';
import { TradeSignal, StrategyParams, MarketState } from '../utils/types';
import { logger } from '../utils/logger';

/**
 * Mean Reversion Strategy
 * - RSI for overbought/oversold detection
 * - Bollinger Bands for price extremes
 * - Mean reversion trades when price touches BB + RSI confirms
 * - ATR-based stop loss
 */
export class MeanReversionStrategy extends BaseStrategy {
  name = 'mean_reversion' as const;
  params: StrategyParams;

  constructor(params?: Partial<StrategyParams>) {
    super();
    this.params = {
      rsiPeriod: params?.rsiPeriod ?? 14,
      rsiOverbought: params?.rsiOverbought ?? 70,
      rsiOversold: params?.rsiOversold ?? 30,
      bbPeriod: params?.bbPeriod ?? 20,
      bbStdDev: params?.bbStdDev ?? 2,
    };
  }

  analyze(state: MarketState): TradeSignal | null {
    const candles1h = state.candles['1h'];
    const candles4h = state.candles['4h'] || [];
    const candles1d = state.candles['1d'] || [];

    const minLen = Math.max(this.params.rsiPeriod! + 2, this.params.bbPeriod! + 2);
    if (!candles1h || candles1h.length < minLen) {
      logger.debug('MeanReversion: Insufficient data');
      return null;
    }

    const closes = candles1h.map((c) => c.close);

    // Calculate indicators
    const rsi = this.calcRSI(closes, this.params.rsiPeriod!);
    const bb = this.calcBollingerBands(closes, this.params.bbPeriod!, this.params.bbStdDev!);
    const atr = this.calcATR(candles1h, 14);

    const len = closes.length;
    const currentPrice = closes[len - 1];
    const prevPrice = closes[len - 2];
    const currentRSI = rsi[len - 1];
    const prevRSI = rsi[len - 2];
    const currentUpper = bb.upper[len - 1];
    const currentLower = bb.lower[len - 1];
    const currentMiddle = bb.middle[len - 1];
    const currentATR = atr[len - 1];

    let signal: TradeSignal | null = null;

    // LONG: Price touches lower BB + RSI oversold + RSI turning up
    const longCondition =
      currentPrice <= currentLower &&
      currentRSI <= this.params.rsiOversold! &&
      currentRSI > prevRSI; // RSI turning up

    // SHORT: Price touches upper BB + RSI overbought + RSI turning down
    const shortCondition =
      currentPrice >= currentUpper &&
      currentRSI >= this.params.rsiOverbought! &&
      currentRSI < prevRSI; // RSI turning down

    if (!longCondition && !shortCondition) {
      return null;
    }

    // Don't trade mean reversion if strong directional trend on higher TFs
    const alignment = this.getTimeframeAlignment(candles1h, candles4h, candles1d);
    if (longCondition && alignment.bearish) {
      logger.debug('MeanReversion: Skipping long — bearish higher TF trend');
      return null;
    }
    if (shortCondition && alignment.bullish) {
      logger.debug('MeanReversion: Skipping short — bullish higher TF trend');
      return null;
    }

    const side = longCondition ? 'long' : 'short';
    const atrMultiple = 1.5; // Tighter stops for mean reversion

    const stopLoss =
      side === 'long'
        ? currentPrice - atrMultiple * currentATR
        : currentPrice + atrMultiple * currentATR;

    // Target: middle Bollinger Band (mean)
    const takeProfit = currentMiddle;

    // Confidence based on how extreme the deviation is
    const deviation =
      side === 'long'
        ? (currentLower - currentPrice) / currentATR
        : (currentPrice - currentUpper) / currentATR;
    const rsiExtreme =
      side === 'long'
        ? (this.params.rsiOversold! - currentRSI) / this.params.rsiOversold!
        : (currentRSI - this.params.rsiOverbought!) / (100 - this.params.rsiOverbought!);
    const confidence = Math.min(0.85, 0.4 + Math.abs(deviation) * 0.15 + rsiExtreme * 0.3);

    signal = {
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
        rsi: currentRSI,
        bbUpper: currentUpper,
        bbLower: currentLower,
        bbMiddle: currentMiddle,
        atr: currentATR,
      },
    };

    logger.info(
      `MeanReversion SIGNAL: ${side.toUpperCase()} ${state.symbol} @ $${currentPrice.toFixed(2)} ` +
        `(RSI: ${currentRSI.toFixed(1)}, confidence: ${(confidence * 100).toFixed(1)}%)`
    );

    return signal;
  }
}
