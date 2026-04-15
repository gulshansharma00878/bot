import axios from 'axios';
import NodeCache from 'node-cache';
import { OHLCV, PriceData, FundingRate, OpenInterest, LiquidityData, Timeframe } from '../utils/types';
import { logger } from '../utils/logger';
import { retryWithBackoff } from '../utils/helpers';

const cache = new NodeCache({ stdTTL: 30, checkperiod: 10 });

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || '';
const COINGECKO_BASE = COINGECKO_API_KEY
  ? 'https://pro-api.coingecko.com/api/v3'
  : 'https://api.coingecko.com/api/v3';
const COINGECKO_HEADERS: Record<string, string> = COINGECKO_API_KEY
  ? { 'x-cg-pro-api-key': COINGECKO_API_KEY }
  : {};
export const COINGECKO_IDS: Record<string, string> = {
  'ETH': 'ethereum',
  'BTC': 'bitcoin',
  'ARB': 'arbitrum',
  'OP': 'optimism',
  'LINK': 'chainlink',
  'SOL': 'solana',
  'AVAX': 'avalanche-2',
  'DOGE': 'dogecoin',
  'WIF': 'dogwifcoin',
  'PEPE': 'pepe',
};

// Rate-limit: max 10-30 req/min on free tier
let lastCoinGeckoCall = 0;
const COINGECKO_MIN_INTERVAL = 2500; // 2.5s between calls

async function rateLimitedCoinGecko<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const elapsed = now - lastCoinGeckoCall;
  if (elapsed < COINGECKO_MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, COINGECKO_MIN_INTERVAL - elapsed));
  }
  lastCoinGeckoCall = Date.now();
  return fn();
}

export async function fetchPrice(symbol: string): Promise<PriceData> {
  const cacheKey = `price_${symbol}`;
  const cached = cache.get<PriceData>(cacheKey);
  if (cached) return cached;

  const geckoId = COINGECKO_IDS[symbol];
  if (!geckoId) {
    throw new Error(`Unknown symbol: ${symbol}. Supported: ${Object.keys(COINGECKO_IDS).join(', ')}`);
  }

  return retryWithBackoff(async () => {
    const data = await rateLimitedCoinGecko(async () => {
      const res = await axios.get(`${COINGECKO_BASE}/simple/price`, {
        params: { ids: geckoId, vs_currencies: 'usd', include_24hr_change: 'true' },
        headers: COINGECKO_HEADERS,
        timeout: 10000,
      });
      return res.data;
    });

    const priceData: PriceData = {
      symbol,
      price: data[geckoId].usd,
      timestamp: Date.now(),
      source: 'coingecko',
    };

    cache.set(cacheKey, priceData, 15);
    logger.debug(`Fetched price for ${symbol}: $${priceData.price}`);
    return priceData;
  });
}

export async function fetchOHLCV(
  symbol: string,
  timeframe: Timeframe = '1h',
  limit: number = 500
): Promise<OHLCV[]> {
  const cacheKey = `ohlcv_${symbol}_${timeframe}_${limit}`;
  const cached = cache.get<OHLCV[]>(cacheKey);
  if (cached) return cached;

  const geckoId = COINGECKO_IDS[symbol];
  if (!geckoId) throw new Error(`Unknown symbol: ${symbol}`);

  // Map timeframes to CoinGecko days parameter
  const daysMap: Record<Timeframe, number> = {
    '1m': 1, '5m': 1, '15m': 1, '1h': 30, '4h': 90, '1d': 365,
  };

  return retryWithBackoff(async () => {
    const data = await rateLimitedCoinGecko(async () => {
      const res = await axios.get(`${COINGECKO_BASE}/coins/${geckoId}/ohlc`, {
        params: { vs_currency: 'usd', days: daysMap[timeframe] || 30 },
        headers: COINGECKO_HEADERS,
        timeout: 15000,
      });
      return res.data;
    });

    // CoinGecko OHLC format: [timestamp, open, high, low, close]
    const candles: OHLCV[] = data.map((d: number[]) => ({
      timestamp: d[0],
      open: d[1],
      high: d[2],
      low: d[3],
      close: d[4],
      volume: 0, // CoinGecko OHLC doesn't include volume
    }));

    // Resample if needed for the desired timeframe
    const resampled = resampleCandles(candles, timeframe);

    cache.set(cacheKey, resampled, getTimeframeTTL(timeframe));
    logger.debug(`Fetched ${resampled.length} candles for ${symbol} ${timeframe}`);
    return resampled.slice(-limit);
  });
}

function getTimeframeTTL(tf: Timeframe): number {
  const ttls: Record<Timeframe, number> = {
    '1m': 30, '5m': 60, '15m': 120, '1h': 300, '4h': 600, '1d': 3600,
  };
  return ttls[tf] || 300;
}

function resampleCandles(candles: OHLCV[], targetTf: Timeframe): OHLCV[] {
  // CoinGecko returns 4h candles for >30d; we just pass them through
  // For production, aggregate properly based on target timeframe
  if (!candles.length) return candles;
  return candles;
}

export async function fetchFundingRate(symbol: string): Promise<FundingRate> {
  const cacheKey = `funding_${symbol}`;
  const cached = cache.get<FundingRate>(cacheKey);
  if (cached) return cached;

  // Simulated funding rate from typical perp protocol data
  // In production, query GMX V2 Reader contract or subgraph
  const fundingRate: FundingRate = {
    symbol,
    rate: (Math.random() - 0.5) * 0.002, // -0.1% to +0.1% typical range
    nextFundingTime: Date.now() + 8 * 3600 * 1000, // 8 hours
    timestamp: Date.now(),
  };

  cache.set(cacheKey, fundingRate, 300);
  return fundingRate;
}

export async function fetchOpenInterest(symbol: string): Promise<OpenInterest> {
  const cacheKey = `oi_${symbol}`;
  const cached = cache.get<OpenInterest>(cacheKey);
  if (cached) return cached;

  // In production: query GMX datastore or subgraph
  const oi: OpenInterest = {
    symbol,
    longOI: 50_000_000 + Math.random() * 20_000_000,
    shortOI: 45_000_000 + Math.random() * 15_000_000,
    totalOI: 0,
    timestamp: Date.now(),
  };
  oi.totalOI = oi.longOI + oi.shortOI;

  cache.set(cacheKey, oi, 120);
  return oi;
}

export async function fetchLiquidity(symbol: string): Promise<LiquidityData> {
  const cacheKey = `liq_${symbol}`;
  const cached = cache.get<LiquidityData>(cacheKey);
  if (cached) return cached;

  // In production: query GMX pool contracts
  const liq: LiquidityData = {
    symbol,
    availableLiquidity: 100_000_000 + Math.random() * 50_000_000,
    maxLongSize: 50_000_000,
    maxShortSize: 50_000_000,
    timestamp: Date.now(),
  };

  cache.set(cacheKey, liq, 120);
  return liq;
}

export async function fetchHistoricalOHLCV(
  symbol: string,
  days: number = 365
): Promise<OHLCV[]> {
  const cacheKey = `hist_ohlcv_${symbol}_${days}`;
  const cached = cache.get<OHLCV[]>(cacheKey);
  if (cached) return cached;

  const geckoId = COINGECKO_IDS[symbol];
  if (!geckoId) throw new Error(`Unknown symbol: ${symbol}`);

  return retryWithBackoff(async () => {
    const data = await rateLimitedCoinGecko(async () => {
      const res = await axios.get(`${COINGECKO_BASE}/coins/${geckoId}/ohlc`, {
        params: { vs_currency: 'usd', days },
        headers: COINGECKO_HEADERS,
        timeout: 30000,
      });
      return res.data;
    });

    const candles: OHLCV[] = data.map((d: number[]) => ({
      timestamp: d[0],
      open: d[1],
      high: d[2],
      low: d[3],
      close: d[4],
      volume: 0,
    }));

    // Enrich with volume data from market_chart
    try {
      const volData = await rateLimitedCoinGecko(async () => {
        const res = await axios.get(`${COINGECKO_BASE}/coins/${geckoId}/market_chart`, {
          params: { vs_currency: 'usd', days },
          headers: COINGECKO_HEADERS,
          timeout: 30000,
        });
        return res.data;
      });

      if (volData.total_volumes) {
        const volumeMap = new Map<number, number>();
        for (const [ts, vol] of volData.total_volumes) {
          // Round to nearest 4h bucket
          const bucket = Math.round(ts / (4 * 3600 * 1000)) * (4 * 3600 * 1000);
          volumeMap.set(bucket, (volumeMap.get(bucket) || 0) + vol);
        }
        for (const c of candles) {
          const bucket = Math.round(c.timestamp / (4 * 3600 * 1000)) * (4 * 3600 * 1000);
          c.volume = volumeMap.get(bucket) || 0;
        }
      }
    } catch (e) {
      logger.warn(`Could not fetch volume data for ${symbol}: ${e}`);
    }

    cache.set(cacheKey, candles, 3600);
    logger.info(`Fetched ${candles.length} historical candles for ${symbol} (${days}d)`);
    return candles;
  });
}

// Generate synthetic historical funding rate data for backtesting
export function generateHistoricalFunding(
  candles: OHLCV[],
  symbol: string
): FundingRate[] {
  const rates: FundingRate[] = [];
  const fundingInterval = 8 * 3600 * 1000; // 8 hours

  if (!candles.length) return rates;

  let ts = candles[0].timestamp;
  const endTs = candles[candles.length - 1].timestamp;

  while (ts <= endTs) {
    // Funding rate correlated with price momentum
    const nearestCandle = candles.reduce((prev, curr) =>
      Math.abs(curr.timestamp - ts) < Math.abs(prev.timestamp - ts) ? curr : prev
    );

    const priceChange = nearestCandle.close / nearestCandle.open - 1;
    // Base rate + momentum component + noise
    const rate = 0.0001 + priceChange * 0.1 + (Math.random() - 0.5) * 0.0003;

    rates.push({
      symbol,
      rate: Math.max(-0.003, Math.min(0.003, rate)), // Clamp to realistic range
      nextFundingTime: ts + fundingInterval,
      timestamp: ts,
    });

    ts += fundingInterval;
  }

  return rates;
}
