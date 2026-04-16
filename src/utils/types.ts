// ============================================
// Core Types for DEX Trading Bot
// ============================================

export type Side = 'long' | 'short';
export type OrderType = 'market' | 'limit';
export type PositionStatus = 'open' | 'closed' | 'liquidated';
export type TradingMode = 'live' | 'paper';
export type StrategyName = 'trend_following' | 'mean_reversion' | 'funding_arbitrage' | 'synced';
export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PriceData {
  symbol: string;
  price: number;
  timestamp: number;
  source: string;
}

export interface FundingRate {
  symbol: string;
  rate: number;            // e.g., 0.01 = 1%
  nextFundingTime: number;
  timestamp: number;
}

export interface OpenInterest {
  symbol: string;
  longOI: number;
  shortOI: number;
  totalOI: number;
  timestamp: number;
}

export interface LiquidityData {
  symbol: string;
  availableLiquidity: number;
  maxLongSize: number;
  maxShortSize: number;
  timestamp: number;
}

export interface TradeSignal {
  strategy: StrategyName;
  symbol: string;
  side: Side;
  confidence: number;    // 0 to 1
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  positionSizeUsd: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  entryPrice: number;
  currentPrice: number;
  size: number;          // in tokens
  sizeUsd: number;
  leverage: number;
  liquidationPrice: number;
  stopLoss: number;
  takeProfit: number;
  trailingStop?: number;
  unrealizedPnl: number;
  realizedPnl: number;
  status: PositionStatus;
  openTime: number;
  closeTime?: number;
  strategy: StrategyName;
  txHash?: string;
}

export interface TradeLog {
  id: string;
  timestamp: number;
  symbol: string;
  side: Side;
  action: 'open' | 'close' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'liquidated';
  price: number;
  size: number;
  sizeUsd: number;
  leverage: number;
  pnl: number;
  fees: number;
  strategy: StrategyName;
  txHash?: string;
}

export interface BacktestResult {
  strategy: StrategyName;
  symbol: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  finalCapital: number;
  totalPnl: number;
  totalPnlPercent: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  avgHoldingPeriodHours: number;
  trades: TradeLog[];
  equityCurve: { timestamp: number; equity: number }[];
}

export interface StrategyParams {
  // Trend Following
  emaFast?: number;
  emaSlow?: number;
  volumeThreshold?: number;

  // Mean Reversion
  rsiPeriod?: number;
  rsiOverbought?: number;
  rsiOversold?: number;
  bbPeriod?: number;
  bbStdDev?: number;

  // Funding Arbitrage
  fundingThreshold?: number;
  minHoldingPeriodHours?: number;
}

export interface MarketState {
  symbol: string;
  price: PriceData;
  fundingRate?: FundingRate;
  openInterest?: OpenInterest;
  liquidity?: LiquidityData;
  candles: Record<Timeframe, OHLCV[]>;
}
