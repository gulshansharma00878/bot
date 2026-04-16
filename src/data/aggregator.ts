import { fetchPrice, fetchOHLCV, fetchFundingRate, fetchOpenInterest, fetchLiquidity } from './feeds';
import { MarketState, Timeframe, PriceData, FundingRate, OpenInterest, LiquidityData, OHLCV } from '../utils/types';
import { logger } from '../utils/logger';

const DEFAULT_TIMEFRAMES: Timeframe[] = ['1h', '4h', '1d'];

// Optional reference to execution engine for Hyperliquid candle data
let _executionEngine: any = null;

export function setExecutionEngine(engine: any): void {
  _executionEngine = engine;
}

export class MarketDataAggregator {
  private symbols: string[];
  private states: Map<string, MarketState> = new Map();

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  async refreshAll(): Promise<void> {
    // Fetch all symbols in parallel for speed
    const promises = this.symbols.map(async (symbol) => {
      try {
        await this.refresh(symbol);
      } catch (error) {
        logger.error(`Failed to refresh data for ${symbol}: ${error}`);
      }
    });
    await Promise.all(promises);
  }

  async refresh(symbol: string): Promise<MarketState> {
    // Try to get price from Hyperliquid first (instant, free)
    let price: PriceData | undefined;
    const hlCtx = _executionEngine?.getAssetCtx(symbol);
    if (hlCtx) {
      price = {
        symbol,
        price: parseFloat(hlCtx.markPx),
        timestamp: Date.now(),
        source: 'hyperliquid',
      };
    }

    // Fallback to CoinGecko for price if HL doesn't have it
    if (!price) {
      try {
        price = await fetchPrice(symbol);
      } catch (e) {
        logger.warn(`Price fetch failed for ${symbol}: ${e}`);
        price = this.states.get(symbol)?.price;
      }
    }

    if (!price) {
      throw new Error(`Cannot get price for ${symbol}`);
    }

    // Use simulated funding/OI/liquidity (these are non-critical for signal generation)
    const [fundingRate, openInterest, liquidity] = await Promise.all([
      fetchFundingRate(symbol).catch(() => this.states.get(symbol)?.fundingRate),
      fetchOpenInterest(symbol).catch(() => this.states.get(symbol)?.openInterest),
      fetchLiquidity(symbol).catch(() => this.states.get(symbol)?.liquidity),
    ]);

    // Candles: use Hyperliquid API (fast, free, real volume data)
    const candles: Record<Timeframe, OHLCV[]> = {} as Record<Timeframe, OHLCV[]>;

    if (_executionEngine) {
      const hlIntervalMap: Record<Timeframe, string> = {
        '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d',
      };

      const candlePromises = DEFAULT_TIMEFRAMES.map(async (tf) => {
        try {
          const hlCandles = await _executionEngine.getCandles(symbol, hlIntervalMap[tf] || tf, 200);
          candles[tf] = hlCandles.map((c: any) => ({
            timestamp: c.t,
            open: c.o,
            high: c.h,
            low: c.l,
            close: c.c,
            volume: c.v,
          }));
          if (candles[tf].length > 0) {
            logger.debug(`[${symbol}] Loaded ${candles[tf].length} ${tf} candles from Hyperliquid`);
          }
        } catch (e) {
          logger.warn(`HL candle fetch failed for ${symbol} ${tf}: ${e}`);
          candles[tf] = this.states.get(symbol)?.candles[tf] || [];
        }
      });
      await Promise.all(candlePromises);
    }

    // Fallback: if HL candles empty, try CoinGecko
    for (const tf of DEFAULT_TIMEFRAMES) {
      if (!candles[tf] || candles[tf].length === 0) {
        try {
          candles[tf] = await fetchOHLCV(symbol, tf, 200);
        } catch (e) {
          logger.warn(`CoinGecko OHLCV fallback failed for ${symbol} ${tf}: ${e}`);
          candles[tf] = this.states.get(symbol)?.candles[tf] || [];
        }
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

  updateSymbols(symbols: string[]): void {
    this.symbols = symbols;
    // Remove states for symbols no longer tracked
    for (const key of this.states.keys()) {
      if (!symbols.includes(key)) {
        this.states.delete(key);
      }
    }
  }

  getSymbols(): string[] {
    return [...this.symbols];
  }
}
