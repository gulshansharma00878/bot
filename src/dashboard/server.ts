import express from 'express';
import { logger } from '../utils/logger';
import { ExecutionEngine } from '../execution/engine';
import { RiskManager } from '../risk/manager';
import { StrategyEngine } from '../strategy';
import { MarketDataAggregator } from '../data/aggregator';
import { BotConfig } from '../utils/config';
import { getDashboardHTML } from './template';

export interface DashboardState {
  config: BotConfig;
  executionEngine: ExecutionEngine;
  riskManager: RiskManager;
  strategyEngine: StrategyEngine;
  dataAggregator: MarketDataAggregator;
  symbols: string[];
  startTime: number;
  isRunning: boolean;
}

export class Dashboard {
  private app: express.Application;
  private state: DashboardState;
  private port: number;

  constructor(state: DashboardState, port: number = 3000) {
    this.state = state;
    this.port = port;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Main dashboard page
    this.app.get('/', (_req, res) => {
      res.send(getDashboardHTML());
    });

    // API: bot status
    this.app.get('/api/status', (_req, res) => {
      const uptime = Math.floor((Date.now() - this.state.startTime) / 1000);
      res.json({
        mode: this.state.config.tradingMode,
        network: this.state.config.network.name,
        strategy: this.state.config.defaultStrategy,
        capital: this.state.riskManager.getCapital(),
        initialCapital: this.state.config.tradingCapitalUsd,
        isRunning: this.state.isRunning,
        circuitBreaker: this.state.riskManager.isCircuitBreakerTripped(),
        uptimeSeconds: uptime,
        symbols: this.state.symbols,
      });
    });

    // API: market prices
    this.app.get('/api/prices', (_req, res) => {
      const prices: Record<string, any> = {};
      for (const symbol of this.state.symbols) {
        const state = this.state.dataAggregator.getState(symbol);
        if (state) {
          prices[symbol] = {
            price: state.price.price,
            timestamp: state.price.timestamp,
            fundingRate: state.fundingRate?.rate ?? null,
            longOI: state.openInterest?.longOI ?? null,
            shortOI: state.openInterest?.shortOI ?? null,
          };
        }
      }
      res.json(prices);
    });

    // API: open positions
    this.app.get('/api/positions', (_req, res) => {
      const positions = this.state.executionEngine.getOpenPositions().map((p) => ({
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice,
        sizeUsd: p.sizeUsd,
        leverage: p.leverage,
        unrealizedPnl: p.unrealizedPnl,
        stopLoss: p.stopLoss,
        takeProfit: p.takeProfit,
        trailingStop: p.trailingStop,
        liquidationPrice: p.liquidationPrice,
        strategy: p.strategy,
        openTime: p.openTime,
      }));
      res.json(positions);
    });

    // API: trade history
    this.app.get('/api/trades', (_req, res) => {
      const trades = this.state.executionEngine.getTradeLogs().map((t) => ({
        id: t.id,
        timestamp: t.timestamp,
        symbol: t.symbol,
        side: t.side,
        action: t.action,
        price: t.price,
        sizeUsd: t.sizeUsd,
        leverage: t.leverage,
        pnl: t.pnl,
        fees: t.fees,
        strategy: t.strategy,
      }));
      res.json(trades);
    });

    // API: all closed positions for equity curve
    this.app.get('/api/equity', (_req, res) => {
      const allPositions = this.state.executionEngine.getAllPositions();
      const initial = this.state.config.tradingCapitalUsd;
      let equity = initial;
      const curve = [{ timestamp: this.state.startTime, equity: initial }];

      for (const p of allPositions) {
        if (p.status !== 'open' && p.closeTime) {
          equity += p.realizedPnl;
          curve.push({ timestamp: p.closeTime, equity });
        }
      }
      curve.push({ timestamp: Date.now(), equity: this.state.riskManager.getCapital() });
      res.json(curve);
    });

    // API: risk metrics
    this.app.get('/api/risk', (_req, res) => {
      const trades = this.state.executionEngine.getTradeLogs().filter((t) => t.action !== 'open');
      const wins = trades.filter((t) => t.pnl > 0);
      const losses = trades.filter((t) => t.pnl <= 0);
      const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);

      res.json({
        totalTrades: trades.length,
        winRate: trades.length > 0 ? wins.length / trades.length : 0,
        totalPnl,
        avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
        avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
        circuitBreaker: this.state.riskManager.isCircuitBreakerTripped(),
        maxRiskPerTrade: this.state.config.risk.maxRiskPerTrade,
        maxDailyLoss: this.state.config.risk.maxDailyLoss,
        maxLeverage: this.state.config.risk.maxLeverage,
      });
    });
  }

  start(): void {
    this.app.listen(this.port, () => {
      logger.info(`Dashboard running at http://localhost:${this.port}`);
    });
  }

  updateState(partial: Partial<DashboardState>): void {
    Object.assign(this.state, partial);
  }
}
