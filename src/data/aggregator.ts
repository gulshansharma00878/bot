import { fetchPrice, fetchOHLCV, fetchFundingRate, fetchOpenInterest, fetchLiquidity } from './feeds';
import { MarketState, Timeframe, PriceData, FundingRate, OpenInterest, LiquidityData, OHLCV } from '../utils/types';
import { logger } from '../utils/logger';

const DEFAULT_TIMEFRAMES: Timeframe[] = ['1h', '4h', '1d'];

export class MarketDataAggregator {
  private symbols: string[];
  private states: Map<string, MarketState> = new Map();

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  async refreshAll(): Promise<void> {
    for (const symbol of this.symbols) {
      try {
        await this.refresh(symbol);
      } catch (error) {
        logger.error(`Failed to refresh data for ${symbol}: ${error}`);
      }
    }
  }

  async refresh(symbol: string): Promise<MarketState> {
    const [price, fundingRate, openInterest, liquidity] = await Promise.all([
      fetchPrice(symbol).catch((e) => {
        logger.warn(`Price fetch failed for ${symbol}: ${e}`);
        return this.states.get(symbol)?.price as PriceData | undefined;
      }),
      fetchFundingRate(symbol).catch((e) => {
        logger.warn(`Funding fetch failed for ${symbol}: ${e}`);
        return this.states.get(symbol)?.fundingRate;
      }),
      fetchOpenInterest(symbol).catch((e) => {
        logger.warn(`OI fetch failed for ${symbol}: ${e}`);
        return this.states.get(symbol)?.openInterest;
      }),
      fetchLiquidity(symbol).catch((e) => {
        logger.warn(`Liquidity fetch failed for ${symbol}: ${e}`);
        return this.states.get(symbol)?.liquidity;
      }),
    ]);

    if (!price) {
      throw new Error(`Cannot get price for ${symbol}`);
    }

    const candles: Record<Timeframe, OHLCV[]> = {} as Record<Timeframe, OHLCV[]>;

    for (const tf of DEFAULT_TIMEFRAMES) {
      try {
        candles[tf] = await fetchOHLCV(symbol, tf, 200);
      } catch (e) {
        logger.warn(`OHLCV fetch failed for ${symbol} ${tf}: ${e}`);
        candles[tf] = this.states.get(symbol)?.candles[tf] || [];
      }
    }

    const state: MarketState = {
      symbol,
      price,
      fundingRate,
      openInterest,
      liquidity,
      candles,
    };

    this.states.set(symbol, state);
    return state;
  }

  getState(symbol: string): MarketState | undefined {
    return this.states.get(symbol);
  }

  getAllStates(): Map<string, MarketState> {
    return this.states;
  }
}
