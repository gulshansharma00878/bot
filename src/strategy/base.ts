import { OHLCV, TradeSignal, StrategyName, MarketState, StrategyParams, Timeframe } from '../utils/types';

export abstract class BaseStrategy {
  abstract name: StrategyName;
  abstract params: StrategyParams;

  abstract analyze(state: MarketState): TradeSignal | null;

  // Multi-timeframe alignment check
  protected getTimeframeAlignment(
    candles1h: OHLCV[],
    candles4h: OHLCV[],
    candles1d: OHLCV[]
  ): { bullish: boolean; bearish: boolean } {
    const trend1h = this.getSimpleTrend(candles1h, 20);
    const trend4h = this.getSimpleTrend(candles4h, 20);
    const trend1d = this.getSimpleTrend(candles1d, 20);

    return {
      bullish: trend1h > 0 && trend4h > 0 && trend1d >= 0,
      bearish: trend1h < 0 && trend4h < 0 && trend1d <= 0,
    };
  }

  protected getSimpleTrend(candles: OHLCV[], period: number): number {
    if (candles.length < period) return 0;
    const recent = candles.slice(-period);
    const firstHalf = recent.slice(0, Math.floor(period / 2));
    const secondHalf = recent.slice(Math.floor(period / 2));
    const avgFirst = firstHalf.reduce((s, c) => s + c.close, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, c) => s + c.close, 0) / secondHalf.length;
    return avgSecond - avgFirst;
  }

  protected calcEMA(data: number[], period: number): number[] {
    const ema: number[] = [];
    const k = 2 / (period + 1);
    ema[0] = data[0];
    for (let i = 1; i < data.length; i++) {
      ema[i] = data[i] * k + ema[i - 1] * (1 - k);
    }
    return ema;
  }

  protected calcRSI(closes: number[], period: number = 14): number[] {
    const rsi: number[] = new Array(closes.length).fill(0);
    if (closes.length < period + 1) return rsi;

    let avgGain = 0;
    let avgLoss = 0;

    for (let i = 1; i <= period; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) avgGain += change;
      else avgLoss += Math.abs(change);
    }

    avgGain /= period;
    avgLoss /= period;

    rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;

      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;

      rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }

    return rsi;
  }

  protected calcBollingerBands(
    closes: number[],
    period: number = 20,
    stdDevMultiplier: number = 2
  ): { upper: number[]; middle: number[]; lower: number[] } {
    const upper: number[] = [];
    const middle: number[] = [];
    const lower: number[] = [];

    for (let i = 0; i < closes.length; i++) {
      if (i < period - 1) {
        upper.push(0);
        middle.push(0);
        lower.push(0);
        continue;
      }

      const slice = closes.slice(i - period + 1, i + 1);
      const mean = slice.reduce((s, v) => s + v, 0) / period;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
      const stdDev = Math.sqrt(variance);

      middle.push(mean);
      upper.push(mean + stdDevMultiplier * stdDev);
      lower.push(mean - stdDevMultiplier * stdDev);
    }

    return { upper, middle, lower };
  }

  protected calcATR(candles: OHLCV[], period: number = 14): number[] {
    const atr: number[] = new Array(candles.length).fill(0);

    for (let i = 1; i < candles.length; i++) {
      const tr = Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close)
      );

      if (i < period) {
        atr[i] = 0;
      } else if (i === period) {
        let sum = 0;
        for (let j = 1; j <= period; j++) {
          sum += Math.max(
            candles[j].high - candles[j].low,
            Math.abs(candles[j].high - candles[j - 1].close),
            Math.abs(candles[j].low - candles[j - 1].close)
          );
        }
        atr[i] = sum / period;
      } else {
        atr[i] = (atr[i - 1] * (period - 1) + tr) / period;
      }
    }

    return atr;
  }

  protected calcVolumeMA(volumes: number[], period: number): number[] {
    const ma: number[] = [];
    for (let i = 0; i < volumes.length; i++) {
      if (i < period - 1) {
        ma.push(0);
        continue;
      }
      const slice = volumes.slice(i - period + 1, i + 1);
      ma.push(slice.reduce((s, v) => s + v, 0) / period);
    }
    return ma;
  }
}
