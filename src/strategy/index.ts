import { BaseStrategy } from './base';
import { TrendFollowingStrategy } from './trendFollowing';
import { MeanReversionStrategy } from './meanReversion';
import { FundingArbitrageStrategy } from './fundingArbitrage';
import { StrategyName, TradeSignal, MarketState, StrategyParams } from '../utils/types';
import { logger } from '../utils/logger';

export class StrategyEngine {
  private strategies: Map<StrategyName, BaseStrategy> = new Map();
  private activeStrategy: StrategyName;

  constructor(defaultStrategy: StrategyName = 'trend_following') {
    this.strategies.set('trend_following', new TrendFollowingStrategy());
    this.strategies.set('mean_reversion', new MeanReversionStrategy());
    // Funding arbitrage disabled — requires real on-chain funding data.
    // Random/simulated funding rates cause pure noise trades → guaranteed losses.
    // this.strategies.set('funding_arbitrage', new FundingArbitrageStrategy());
    this.activeStrategy = defaultStrategy;
    logger.info(`Strategy engine initialized. Active: ${defaultStrategy} (funding_arb disabled — no real data)`);
  }

  switchStrategy(name: StrategyName): void {
    if (!this.strategies.has(name)) {
      throw new Error(`Unknown strategy: ${name}`);
    }
    this.activeStrategy = name;
    logger.info(`Switched active strategy to: ${name}`);
  }

  getActiveStrategy(): BaseStrategy {
    return this.strategies.get(this.activeStrategy)!;
  }

  analyze(state: MarketState): TradeSignal | null {
    const strategy = this.strategies.get(this.activeStrategy);
    if (!strategy) {
      throw new Error(`Strategy ${this.activeStrategy} not found`);
    }
    return strategy.analyze(state);
  }

  // Run all strategies and return the best signal (highest confidence)
  analyzeAll(state: MarketState): TradeSignal | null {
    let bestSignal: TradeSignal | null = null;

    for (const [name, strategy] of this.strategies) {
      try {
        const signal = strategy.analyze(state);
        if (signal && (!bestSignal || signal.confidence > bestSignal.confidence)) {
          bestSignal = signal;
        }
      } catch (error) {
        logger.error(`Strategy ${name} error: ${error}`);
      }
    }

    return bestSignal;
  }

  getStrategyNames(): StrategyName[] {
    return Array.from(this.strategies.keys());
  }
}

export { BaseStrategy, TrendFollowingStrategy, MeanReversionStrategy, FundingArbitrageStrategy };
