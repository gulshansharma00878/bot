import express from 'express';
import { logger } from '../utils/logger';
import { ExecutionEngine } from '../execution/engine';
import { RiskManager } from '../risk/manager';
import { StrategyEngine } from '../strategy';
import { MarketDataAggregator } from '../data/aggregator';
import { BotConfig } from '../utils/config';
import { getDashboardHTML } from './template';
import { COINGECKO_IDS } from '../data/feeds';

export interface SymbolEntry { symbol: string; geckoId: string; }

export interface BotSettings {
  strategy: string;
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxLeverage: number;
  defaultLeverage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
  confidenceThreshold: number;
  maxConcurrentPositions: number;
  highVolThreshold: number;
  highVolLeverage: number;
  medVolThreshold: number;
  medVolLeverage: number;
  lowVolThreshold: number;
  lowVolLeverage: number;
  minVolLeverage: number;
  tradingCapitalUsd: number;
  loopIntervalMs: number;
  tradeCooldownMs: number;
}

export interface DashboardState {
  config: BotConfig;
  executionEngine: ExecutionEngine;
  riskManager: RiskManager;
  strategyEngine: StrategyEngine;
  dataAggregator: MarketDataAggregator;
  symbols: string[];
  symbolEntries: SymbolEntry[];
  startTime: number;
  isRunning: boolean;
  loopIntervalMs: number;
  tradeCooldownMs: number;
  onSymbolsChanged?: (entries: SymbolEntry[]) => void;
  onSettingsChanged?: (settings: Partial<BotSettings>) => void;
}

export class Dashboard {
  private app: express.Application;
  private state: DashboardState;
  private port: number;

  constructor(state: DashboardState, port: number = 3000) {
    this.state = state;
    this.port = port;
    this.app = express();
    this.app.use(express.json());
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
        symbolEntries: this.state.symbolEntries,
      });
    });

    // API: market prices (enriched with Hyperliquid data)
    this.app.get('/api/prices', async (_req, res) => {
      const prices: Record<string, any> = {};
      for (const symbol of this.state.symbols) {
        const state = this.state.dataAggregator.getState(symbol);
        const hlCtx = this.state.executionEngine.getAssetCtx(symbol);
        if (state) {
          prices[symbol] = {
            price: hlCtx ? parseFloat(hlCtx.markPx) : state.price.price,
            oraclePrice: hlCtx ? parseFloat(hlCtx.oraclePx) : null,
            timestamp: state.price.timestamp,
            fundingRate: hlCtx ? parseFloat(hlCtx.funding) : (state.fundingRate?.rate ?? null),
            openInterest: hlCtx ? parseFloat(hlCtx.openInterest) : null,
            dayVolume: hlCtx ? parseFloat(hlCtx.dayNtlVlm) : null,
            prevDayPx: hlCtx ? parseFloat(hlCtx.prevDayPx) : null,
            premium: hlCtx?.premium ? parseFloat(hlCtx.premium) : null,
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
      const totalFees = trades.reduce((s, t) => s + t.fees, 0);
      const bestTrade = trades.length > 0 ? Math.max(...trades.map(t => t.pnl)) : 0;
      const worstTrade = trades.length > 0 ? Math.min(...trades.map(t => t.pnl)) : 0;

      res.json({
        totalTrades: trades.length,
        winRate: trades.length > 0 ? wins.length / trades.length : 0,
        totalPnl,
        totalFees,
        bestTrade,
        worstTrade,
        avgWin: wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0,
        avgLoss: losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0,
        profitFactor: losses.length > 0
          ? Math.abs(wins.reduce((s, t) => s + t.pnl, 0) / losses.reduce((s, t) => s + t.pnl, 0))
          : wins.length > 0 ? Infinity : 0,
        circuitBreaker: this.state.riskManager.isCircuitBreakerTripped(),
        maxRiskPerTrade: this.state.config.risk.maxRiskPerTrade,
        maxDailyLoss: this.state.config.risk.maxDailyLoss,
        maxLeverage: this.state.config.risk.maxLeverage,
      });
    });

    // API: Hyperliquid account state (live balance, on-chain positions)
    // Supports both classic and unified account modes
    this.app.get('/api/account', async (_req, res) => {
      try {
        const balance = await this.state.executionEngine.getWalletBalance();
        const state = await this.state.executionEngine.getAccountState();
        if (!state) {
          res.json({ connected: false });
          return;
        }
        const perpVal = parseFloat(state.marginSummary.accountValue);
        const isUnified = perpVal < 1 && balance >= 1;

        const onChainPositions = state.assetPositions
          .filter(ap => parseFloat(ap.position.szi) !== 0)
          .map(ap => ({
            coin: ap.position.coin,
            size: ap.position.szi,
            entryPx: ap.position.entryPx,
            markPx: ap.position.positionValue,
            unrealizedPnl: ap.position.unrealizedPnl,
            leverage: ap.position.leverage,
            liquidationPx: ap.position.liquidationPx,
            marginUsed: ap.position.marginUsed,
          }));
        res.json({
          connected: true,
          accountMode: isUnified ? 'unified' : 'classic',
          accountValue: balance.toFixed(2),
          totalMarginUsed: state.marginSummary.totalMarginUsed,
          withdrawable: isUnified ? balance.toFixed(2) : state.withdrawable,
          totalNtlPos: state.marginSummary.totalNtlPos,
          onChainPositions,
        });
      } catch {
        res.json({ connected: false });
      }
    });

    // API: get available Hyperliquid coins
    this.app.get('/api/available-coins', (_req, res) => {
      const coins = this.state.executionEngine.getAvailableCoins();
      res.json(coins);
    });

    // API: add symbol
    this.app.post('/api/symbols', (req, res) => {
      const { symbol, geckoId } = req.body;
      if (!symbol || typeof symbol !== 'string' || !geckoId || typeof geckoId !== 'string') {
        res.status(400).json({ error: 'symbol and geckoId are both required' });
        return;
      }
      const coin = symbol.toUpperCase().trim();
      const gid = geckoId.toLowerCase().trim();
      if (this.state.symbols.includes(coin)) {
        res.status(409).json({ error: `${coin} is already being tracked` });
        return;
      }
      // Validate against Hyperliquid available coins
      const available = this.state.executionEngine.getAvailableCoins();
      if (available.length > 0 && !available.includes(coin)) {
        res.status(400).json({ error: `${coin} is not available on Hyperliquid` });
        return;
      }
      // Register the CoinGecko mapping
      COINGECKO_IDS[coin] = gid;
      const entry: SymbolEntry = { symbol: coin, geckoId: gid };
      this.state.symbols.push(coin);
      this.state.symbolEntries.push(entry);
      if (this.state.onSymbolsChanged) {
        this.state.onSymbolsChanged([...this.state.symbolEntries]);
      }
      logger.info(`Symbol added via dashboard: ${coin} (geckoId: ${gid})`);
      res.json({ symbols: this.state.symbols, symbolEntries: this.state.symbolEntries });
    });

    // API: remove symbol
    this.app.delete('/api/symbols/:symbol', (req, res) => {
      const coin = req.params.symbol.toUpperCase().trim();
      const idx = this.state.symbols.indexOf(coin);
      if (idx === -1) {
        res.status(404).json({ error: `${coin} is not being tracked` });
        return;
      }
      // Don't allow removing last symbol
      if (this.state.symbols.length <= 1) {
        res.status(400).json({ error: 'Cannot remove the last symbol' });
        return;
      }
      this.state.symbols.splice(idx, 1);
      this.state.symbolEntries = this.state.symbolEntries.filter(e => e.symbol !== coin);
      if (this.state.onSymbolsChanged) {
        this.state.onSymbolsChanged([...this.state.symbolEntries]);
      }
      logger.info(`Symbol removed via dashboard: ${coin}`);
      res.json({ symbols: this.state.symbols, symbolEntries: this.state.symbolEntries });
    });

    // API: get all settings
    this.app.get('/api/settings', (_req, res) => {
      const risk = this.state.riskManager.getRiskConfig();
      const strategies = this.state.strategyEngine.getStrategyNames();
      res.json({
        strategy: this.state.config.defaultStrategy,
        strategies,
        maxRiskPerTrade: risk.maxRiskPerTrade,
        maxDailyLoss: risk.maxDailyLoss,
        maxLeverage: risk.maxLeverage,
        defaultLeverage: risk.defaultLeverage,
        stopLossPercent: risk.stopLossPercent,
        takeProfitPercent: risk.takeProfitPercent,
        trailingStopPercent: risk.trailingStopPercent,
        confidenceThreshold: risk.confidenceThreshold,
        maxConcurrentPositions: risk.maxConcurrentPositions,
        highVolThreshold: risk.highVolThreshold,
        highVolLeverage: risk.highVolLeverage,
        medVolThreshold: risk.medVolThreshold,
        medVolLeverage: risk.medVolLeverage,
        lowVolThreshold: risk.lowVolThreshold,
        lowVolLeverage: risk.lowVolLeverage,
        minVolLeverage: risk.minVolLeverage,
        tradingCapitalUsd: this.state.config.tradingCapitalUsd,
        loopIntervalMs: this.state.loopIntervalMs,
        tradeCooldownMs: this.state.tradeCooldownMs,
        tradingMode: this.state.config.tradingMode,
      });
    });

    // API: update settings
    this.app.put('/api/settings', (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object') {
        res.status(400).json({ error: 'Invalid body' });
        return;
      }

      const updates: Partial<BotSettings> = {};
      const riskUpdates: Record<string, number> = {};

      // Validate and collect changes
      if (body.strategy !== undefined && typeof body.strategy === 'string') {
        const strategies = this.state.strategyEngine.getStrategyNames();
        if (!strategies.includes(body.strategy)) {
          res.status(400).json({ error: `Unknown strategy: ${body.strategy}. Available: ${strategies.join(', ')}` });
          return;
        }
        updates.strategy = body.strategy;
      }

      const numericFields: Array<{ key: keyof BotSettings; min: number; max: number; isRisk?: boolean }> = [
        { key: 'maxRiskPerTrade', min: 0.001, max: 0.5, isRisk: true },
        { key: 'maxDailyLoss', min: 0.01, max: 1.0, isRisk: true },
        { key: 'maxLeverage', min: 1, max: 100, isRisk: true },
        { key: 'defaultLeverage', min: 1, max: 100, isRisk: true },
        { key: 'stopLossPercent', min: 0.001, max: 0.5, isRisk: true },
        { key: 'takeProfitPercent', min: 0.001, max: 1.0, isRisk: true },
        { key: 'trailingStopPercent', min: 0.001, max: 0.5, isRisk: true },
        { key: 'confidenceThreshold', min: 0.1, max: 1.0, isRisk: true },
        { key: 'maxConcurrentPositions', min: 1, max: 20, isRisk: true },
        { key: 'highVolThreshold', min: 0.001, max: 0.5, isRisk: true },
        { key: 'highVolLeverage', min: 1, max: 100, isRisk: true },
        { key: 'medVolThreshold', min: 0.001, max: 0.5, isRisk: true },
        { key: 'medVolLeverage', min: 1, max: 100, isRisk: true },
        { key: 'lowVolThreshold', min: 0.001, max: 0.5, isRisk: true },
        { key: 'lowVolLeverage', min: 1, max: 100, isRisk: true },
        { key: 'minVolLeverage', min: 1, max: 100, isRisk: true },
        { key: 'tradingCapitalUsd', min: 1, max: 10000000 },
        { key: 'loopIntervalMs', min: 10000, max: 3600000 },
        { key: 'tradeCooldownMs', min: 0, max: 86400000 },
      ];

      for (const field of numericFields) {
        if (body[field.key] !== undefined) {
          const val = parseFloat(body[field.key]);
          if (isNaN(val) || val < field.min || val > field.max) {
            res.status(400).json({ error: `${field.key} must be between ${field.min} and ${field.max}` });
            return;
          }
          (updates as any)[field.key] = val;
          if (field.isRisk) riskUpdates[field.key] = val;
        }
      }

      // Apply changes
      if (updates.strategy) {
        this.state.strategyEngine.switchStrategy(updates.strategy as any);
        this.state.config.defaultStrategy = updates.strategy;
      }
      if (Object.keys(riskUpdates).length > 0) {
        this.state.riskManager.updateRiskConfig(riskUpdates as any);
        Object.assign(this.state.config.risk, riskUpdates);
      }
      if (updates.tradingCapitalUsd !== undefined) {
        this.state.config.tradingCapitalUsd = updates.tradingCapitalUsd;
        this.state.riskManager.updateCapital(updates.tradingCapitalUsd);
      }
      if (updates.loopIntervalMs !== undefined) {
        this.state.loopIntervalMs = updates.loopIntervalMs;
      }
      if (updates.tradeCooldownMs !== undefined) {
        this.state.tradeCooldownMs = updates.tradeCooldownMs;
      }

      if (this.state.onSettingsChanged) {
        this.state.onSettingsChanged(updates);
      }

      logger.info(`Settings updated via dashboard: ${JSON.stringify(updates)}`);
      res.json({ ok: true, applied: updates });
    });

    // API: reset circuit breaker
    this.app.post('/api/reset-circuit-breaker', (_req, res) => {
      this.state.riskManager.resetCircuitBreaker();
      logger.info('Circuit breaker reset via dashboard');
      res.json({ ok: true });
    });
  }

  start(): void {
    this.app.listen(this.port, '0.0.0.0', () => {
      logger.info(`Dashboard running at http://0.0.0.0:${this.port}`);
    });
  }

  updateState(partial: Partial<DashboardState>): void {
    Object.assign(this.state, partial);
  }
}
