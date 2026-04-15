import { loadConfig, BotConfig } from './utils/config';
import { logger } from './utils/logger';
import { StrategyEngine } from './strategy';
import { RiskManager } from './risk/manager';
import { ExecutionEngine } from './execution/engine';
import { MarketDataAggregator } from './data/aggregator';
import { NotificationService } from './notifications/service';
import { Dashboard } from './dashboard/server';
import { StrategyName, Position, TradeSignal } from './utils/types';
import { sleep } from './utils/helpers';

class TradingBot {
  private config: BotConfig;
  private strategyEngine: StrategyEngine;
  private riskManager: RiskManager;
  private executionEngine: ExecutionEngine;
  private dataAggregator: MarketDataAggregator;
  private notificationService: NotificationService;
  private isRunning: boolean = false;
  private symbols: string[] = ['ETH', 'SOL', 'ARB', 'LINK', 'DOGE', 'WIF'];
  private loopIntervalMs: number = 60_000; // 1 minute main loop
  private lastTradeTime: Map<string, number> = new Map(); // Cooldown per symbol
  private tradeCooldownMs: number = 15 * 60_000; // 15 min between trades on same symbol

  constructor(config: BotConfig) {
    this.config = config;
    this.strategyEngine = new StrategyEngine(config.defaultStrategy as StrategyName);
    this.riskManager = new RiskManager(config.risk, config.tradingCapitalUsd);
    this.executionEngine = new ExecutionEngine(config);
    this.dataAggregator = new MarketDataAggregator(this.symbols);
    this.notificationService = new NotificationService(
      config.telegramBotToken,
      config.telegramChatId,
      config.discordWebhookUrl
    );
  }

  async start(): Promise<void> {
    logger.info('='.repeat(50));
    logger.info('  Hyperliquid Perpetual Futures Trading Bot');
    logger.info('='.repeat(50));
    logger.info(`Mode:       ${this.config.tradingMode.toUpperCase()}`);
    logger.info(`Network:    ${this.config.network.name}`);
    logger.info(`Strategy:   ${this.config.defaultStrategy}`);
    logger.info(`Capital:    $${this.config.tradingCapitalUsd.toLocaleString()}`);
    logger.info(`Symbols:    ${this.symbols.join(', ')}`);
    logger.info(`Risk/trade: ${(this.config.risk.maxRiskPerTrade * 100).toFixed(1)}%`);
    logger.info(`Max daily loss: ${(this.config.risk.maxDailyLoss * 100).toFixed(1)}%`);
    logger.info('='.repeat(50));

    if (this.config.tradingMode === 'live' && !this.config.privateKey) {
      logger.error('PRIVATE_KEY required for live trading. Exiting.');
      process.exit(1);
    }

    this.isRunning = true;

    // Initialize Hyperliquid client (load market metadata)
    await this.executionEngine.initialize();

    // Start dashboard
    const dashboard = new Dashboard({
      config: this.config,
      executionEngine: this.executionEngine,
      riskManager: this.riskManager,
      strategyEngine: this.strategyEngine,
      dataAggregator: this.dataAggregator,
      symbols: this.symbols,
      startTime: Date.now(),
      isRunning: this.isRunning,
    }, parseInt(process.env.PORT || '3000', 10));
    dashboard.start();

    await this.notificationService.notifyAlert(
      'Bot Started',
      `Mode: ${this.config.tradingMode}, Strategy: ${this.config.defaultStrategy}`
    );

    // Main trading loop
    while (this.isRunning) {
      try {
        await this.tradingLoop();
      } catch (error) {
        logger.error(`Trading loop error: ${error}`);
        await this.notificationService.notifyAlert('Bot Error', `${error}`);
      }

      await sleep(this.loopIntervalMs);
    }
  }

  private async tradingLoop(): Promise<void> {
    // 1. Refresh market data
    logger.info('Refreshing market data...');
    await Promise.all([
      this.dataAggregator.refreshAll(),
      this.executionEngine.refreshAssetCtxs(),
    ]);
    logger.info('Market data refreshed.');

    // 2. Check existing positions for exits
    const openPositions = this.executionEngine.getOpenPositions();
    const currentPrices = new Map<string, number>();

    for (const symbol of this.symbols) {
      const state = this.dataAggregator.getState(symbol);
      if (state) {
        currentPrices.set(symbol, state.price.price);
      }
    }

    const positionsToClose = this.riskManager.checkPositionExits(openPositions, currentPrices);

    for (const pos of positionsToClose) {
      const currentPrice = currentPrices.get(pos.symbol) || pos.currentPrice;
      let reason: 'stop_loss' | 'take_profit' | 'trailing_stop' | 'liquidated' = 'stop_loss';

      // Determine the reason
      if (pos.side === 'long') {
        if (currentPrice >= pos.takeProfit) reason = 'take_profit';
        else if (pos.trailingStop && currentPrice <= pos.trailingStop) reason = 'trailing_stop';
        else if (Math.abs(currentPrice - pos.liquidationPrice) / currentPrice < 0.02) reason = 'liquidated';
      } else {
        if (currentPrice <= pos.takeProfit) reason = 'take_profit';
        else if (pos.trailingStop && currentPrice >= pos.trailingStop) reason = 'trailing_stop';
        else if (Math.abs(currentPrice - pos.liquidationPrice) / currentPrice < 0.02) reason = 'liquidated';
      }

      const closed = await this.executionEngine.closePosition(pos.id, currentPrice, reason);
      if (closed) {
        this.riskManager.recordTradePnl(closed.realizedPnl);
        await this.notificationService.notifyTradeClose(closed, reason);
      }
    }

    // 3. Generate new signals if circuit breaker not tripped
    if (this.riskManager.isCircuitBreakerTripped()) {
      logger.warn('Circuit breaker active — skipping signal generation');
      return;
    }

    for (const symbol of this.symbols) {
      const state = this.dataAggregator.getState(symbol);
      if (!state) continue;

      const price = state.price.price;
      const funding = state.fundingRate?.rate ?? 0;
      logger.info(
        `[${symbol}] Price: $${price.toFixed(2)} | Funding: ${(funding * 100).toFixed(4)}%`
      );

      // Check if we already have an open position for this symbol
      const existingPosition = openPositions.find(
        (p) => p.symbol === symbol && p.status === 'open'
      );
      if (existingPosition) continue;

      // Cooldown: don't re-enter a symbol too quickly after closing
      const lastTrade = this.lastTradeTime.get(symbol) || 0;
      if (Date.now() - lastTrade < this.tradeCooldownMs) {
        const waitMins = Math.ceil((this.tradeCooldownMs - (Date.now() - lastTrade)) / 60000);
        logger.info(`[${symbol}] Cooldown active (${waitMins}m remaining)`);
        continue;
      }

      // Run all strategies and pick best signal
      const signal = this.strategyEngine.analyzeAll(state);
      if (!signal) {
        logger.info(`[${symbol}] No signal this cycle`);
        continue;
      }

      // Validate through risk manager
      const validatedSignal = this.riskManager.validateSignal(
        signal,
        this.executionEngine.getOpenPositions()
      );
      if (!validatedSignal) continue;

      // Execute
      const position = await this.executionEngine.openPosition(validatedSignal);
      if (position) {
        this.lastTradeTime.set(symbol, Date.now());
        await this.notificationService.notifyTradeOpen(position);
      }
    }

    // 4. Log status
    const allOpen = this.executionEngine.getOpenPositions();
    if (allOpen.length > 0) {
      for (const p of allOpen) {
        const price = currentPrices.get(p.symbol) || p.currentPrice;
        const pnlPercent = p.side === 'long'
          ? (price - p.entryPrice) / p.entryPrice
          : (p.entryPrice - price) / p.entryPrice;
        logger.info(
          `Position: ${p.side.toUpperCase()} ${p.symbol} | ` +
            `Entry: $${p.entryPrice.toFixed(2)} | Current: $${price.toFixed(2)} | ` +
            `uPnL: ${(pnlPercent * 100 * p.leverage).toFixed(2)}%`
        );
      }
    }
  }

  stop(): void {
    logger.info('Stopping trading bot...');
    this.isRunning = false;
  }

  switchStrategy(name: StrategyName): void {
    this.strategyEngine.switchStrategy(name);
    logger.info(`Strategy switched to: ${name}`);
  }
}

// =============================================
// MAIN ENTRY POINT
// =============================================
async function main(): Promise<void> {
  // Parse CLI args
  const args = process.argv.slice(2);
  let mode: 'live' | 'paper' | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' && args[i + 1]) {
      mode = args[i + 1] as 'live' | 'paper';
    }
  }

  const config = loadConfig();
  if (mode) {
    config.tradingMode = mode;
  }

  // Safety check: require explicit --mode live for live trading
  if (config.tradingMode === 'live') {
    if (!process.argv.includes('--mode') || !process.argv.includes('live')) {
      logger.error('Live trading requires explicit --mode live flag. Defaulting to paper.');
      config.tradingMode = 'paper';
    }
  }

  const bot = new TradingBot(config);

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('SIGINT received. Shutting down gracefully...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
  });

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    bot.stop();
    setTimeout(() => process.exit(0), 3000);
  });

  await bot.start();
}

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});
