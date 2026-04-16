import { BaseStrategy } from './base';
import { TradeSignal, StrategyParams, MarketState } from '../utils/types';
import { logger } from '../utils/logger';

/**
 * Trend Following Strategy
 * - EMA crossover (fast crosses above slow = long, fast crosses below slow = short)
 * - Volume confirmation (volume above average)
 * - Multi-timeframe alignment
 * - ATR-based stop loss and position sizing
 */
export class TrendFollowingStrategy extends BaseStrategy {
  name = 'trend_following' as const;
  params: StrategyParams;

  constructor(params?: Partial<StrategyParams>) {
    super();
    this.params = {
      emaFast: params?.emaFast ?? 9,
      emaSlow: params?.emaSlow ?? 21,
      volumeThreshold: params?.volumeThreshold ?? 0.8, // 0.8x average volume (crypto volume is uneven)
    };
  }

  analyze(state: MarketState): TradeSignal | null {
    const candles1h = state.candles['1h'];
    const candles4h = state.candles['4h'];
    const candles1d = state.candles['1d'];

    if (!candles1h || candles1h.length < (this.params.emaSlow! + 5)) {
      logger.debug(`TrendFollowing [${state.symbol}]: Insufficient 1h data (${candles1h?.length || 0} candles, need ${this.params.emaSlow! + 5})`);
      return null;
    }

    const closes = candles1h.map((c) => c.close);
    const volumes = candles1h.map((c) => c.volume);

    // Calculate indicators
    const emaFast = this.calcEMA(closes, this.params.emaFast!);
    const emaSlow = this.calcEMA(closes, this.params.emaSlow!);
    const atr = this.calcATR(candles1h, 14);
    const volumeMA = this.calcVolumeMA(volumes, 20);

    const len = closes.length;
    const currentPrice = closes[len - 1];
    const prevFast = emaFast[len - 2];
    const currFast = emaFast[len - 1];
    const prevSlow = emaSlow[len - 2];
    const currSlow = emaSlow[len - 1];
    const currentATR = atr[len - 1];
    const currentVol = volumes[len - 1];
    const avgVol = volumeMA[len - 1];

    // Check for EMA crossover OR strong trend (EMA separation)
    const bullishCross = prevFast <= prevSlow && currFast > currSlow;
    const bearishCross = prevFast >= prevSlow && currFast < currSlow;

    // Trend continuation: require separation AND price near fast EMA
    const emaSeparation = Math.abs(currFast - currSlow) / currentPrice;
    const priceNearFastEma = Math.abs(currentPrice - currFast) / currentPrice < 0.02;
    const bullishTrend = !bullishCross && currFast > currSlow && emaSeparation > 0.002 && priceNearFastEma;
    const bearishTrend = !bearishCross && currFast < currSlow && emaSeparation > 0.002 && priceNearFastEma;

    const isBullish = bullishCross || bullishTrend;
    const isBearish = bearishCross || bearishTrend;

    logger.debug(`TrendFollowing [${state.symbol}]: EMA fast=${currFast.toFixed(4)} slow=${currSlow.toFixed(4)} sep=${emaSeparation.toFixed(5)} priceNearEma=${(Math.abs(currentPrice - currFast) / currentPrice).toFixed(5)} bullCross=${bullishCross} bearCross=${bearishCross} bullTrend=${bullishTrend} bearTrend=${bearishTrend}`);

    if (!isBullish && !isBearish) {
      return null;
    }

    // Volume confirmation — only required for crossover signals (higher risk entry)
    // Trend continuation signals already confirmed by EMA separation + multi-TF alignment
    const isCrossover = bullishCross || bearishCross;
    const prevVol = volumes[len - 2];
    if (isCrossover) {
      const volumeConfirmed = avgVol > 0 ? prevVol >= avgVol * this.params.volumeThreshold! : true;
      if (!volumeConfirmed) {
        logger.debug(`TrendFollowing [${state.symbol}]: Crossover volume not confirmed (prev=${prevVol.toFixed(2)} < ${(avgVol * this.params.volumeThreshold!).toFixed(2)})`);
        return null;
      }
    }

    // Multi-timeframe alignment
    const alignment = this.getTimeframeAlignment(
      candles1h || [],
      candles4h || [],
      candles1d || []
    );

    if (isBullish && !alignment.bullish) {
      logger.debug(`TrendFollowing [${state.symbol}]: Bullish signal but no multi-TF alignment`);
      return null;
    }
    if (isBearish && !alignment.bearish) {
      logger.debug(`TrendFollowing [${state.symbol}]: Bearish signal but no multi-TF alignment`);
      return null;
    }

    const side = isBullish ? 'long' : 'short';
    // Wider stops (3x ATR) to avoid getting stopped by normal volatility
    // TP at 4.5x ATR → 1.5:1 reward-to-risk ratio (profitable at >40% win rate)
    const slMultiple = 3;
    const tpMultiple = 4.5;
    const stopLoss =
      side === 'long'
        ? currentPrice - slMultiple * currentATR
        : currentPrice + slMultiple * currentATR;
    const takeProfit =
      side === 'long'
        ? currentPrice + tpMultiple * currentATR
        : currentPrice - tpMultiple * currentATR;

    // Confidence: crossovers > trend continuation
    const crossoverStrength = Math.abs(currFast - currSlow) / currentPrice;
    const confidence = Math.min(0.9, (isCrossover ? 0.6 : 0.45) + crossoverStrength * 80);

    const signal: TradeSignal = {
      strategy: this.name,
      symbol: state.symbol,
      side,
      confidence,
      entryPrice: currentPrice,
      stopLoss,
      takeProfit,
      leverage: 0, // Set by risk manager
      positionSizeUsd: 0, // Set by risk manager
      timestamp: Date.now(),
      metadata: {
        emaFast: currFast,
        emaSlow: currSlow,
        atr: currentATR,
        volumeRatio: avgVol > 0 ? currentVol / avgVol : 0,
      },
    };

    logger.info(
      `TrendFollowing SIGNAL: ${side.toUpperCase()} ${state.symbol} @ $${currentPrice.toFixed(2)} ` +
        `(confidence: ${(confidence * 100).toFixed(1)}%, SL: $${stopLoss.toFixed(2)}, TP: $${takeProfit.toFixed(2)})`
    );

    return signal;
  }
}
