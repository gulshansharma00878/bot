import { Position, TradeSignal, TradeLog, Side, TradingMode } from '../utils/types';
import { BotConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { generateId, retryWithBackoff, sleep } from '../utils/helpers';
import { HyperliquidClient, HlAccountState, HlAssetCtx } from './hyperliquid';

// Supported symbols on Hyperliquid (perp names match exactly)
const HL_COINS = ['ETH', 'BTC', 'SOL', 'ARB', 'LINK', 'OP', 'AVAX', 'DOGE', 'WIF', 'PEPE'];

export class ExecutionEngine {
  private client: HyperliquidClient | null = null;
  private config: BotConfig;
  private positions: Map<string, Position> = new Map();
  private tradeLogs: TradeLog[] = [];
  private mode: TradingMode;
  private metaLoaded = false;
  private assetCtxCache: Map<string, HlAssetCtx> = new Map();

  constructor(config: BotConfig) {
    this.config = config;
    this.mode = config.tradingMode;

    if (config.privateKey) {
      this.client = new HyperliquidClient(config.privateKey);
      if (this.mode === 'live') {
        logger.info(`Execution engine: LIVE on Hyperliquid | Wallet: ${this.client.address}`);
      } else {
        logger.info(`Execution engine: PAPER mode (Hyperliquid reads only)`);
      }
    } else {
      logger.info('Execution engine: PAPER TRADING mode (no key)');
    }
  }

  /** Must be called once before trading to load market metadata */
  async initialize(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.loadMeta();
      this.metaLoaded = true;

      // Fetch account state — supports both classic and unified accounts
      const state = await this.client.getUserState();
      const perpBalance = parseFloat(state.marginSummary.accountValue);

      // In Unified Account mode, perp clearinghouseState may show $0
      // because all funds live in the spot balance. Check spot USDC too.
      const spotState = await this.client.getSpotState();
      const usdcEntry = spotState.balances.find(b => b.coin === 'USDC');
      const spotUsdc = usdcEntry ? parseFloat(usdcEntry.total) : 0;

      const effectiveBalance = Math.max(perpBalance, spotUsdc);

      if (perpBalance >= 1) {
        logger.info(
          `Hyperliquid account (classic): $${perpBalance.toFixed(2)} ` +
            `| Withdrawable: $${parseFloat(state.withdrawable).toFixed(2)}`
        );
      } else if (spotUsdc >= 1) {
        logger.info(
          `Hyperliquid account (unified): $${spotUsdc.toFixed(2)} USDC available for trading ` +
            `| Perp shows $${perpBalance.toFixed(2)} (normal in unified mode)`
        );
      } else {
        logger.warn(
          `No balance found. Perp: $${perpBalance.toFixed(2)}, Spot USDC: $${spotUsdc.toFixed(2)}. ` +
            `Deposit USDC via https://app.hyperliquid.xyz`
        );
      }

      logger.info(`Effective trading balance: $${effectiveBalance.toFixed(2)}`);
    } catch (e) {
      logger.error(`Failed to initialize Hyperliquid client: ${e}`);
    }
  }

  // =============================================
  // Refresh asset contexts (prices, funding, OI)
  // =============================================
  async refreshAssetCtxs(): Promise<void> {
    if (!this.client) return;
    try {
      const [meta, ctxs] = await this.client.getMetaAndAssetCtxs();
      meta.universe.forEach((u, i) => {
        if (ctxs[i]) this.assetCtxCache.set(u.name, ctxs[i]);
      });
    } catch (e) {
      logger.error(`Failed to refresh Hyperliquid asset contexts: ${e}`);
    }
  }

  getAssetCtx(coin: string): HlAssetCtx | undefined {
    return this.assetCtxCache.get(coin);
  }

  // =============================================
  // Open Position
  // =============================================
  async openPosition(signal: TradeSignal): Promise<Position | null> {
    const positionId = generateId();

    try {
      const position: Position = {
        id: positionId,
        symbol: signal.symbol,
        side: signal.side,
        entryPrice: signal.entryPrice,
        currentPrice: signal.entryPrice,
        size: signal.positionSizeUsd / signal.entryPrice,
        sizeUsd: signal.positionSizeUsd,
        leverage: signal.leverage,
        liquidationPrice: calcLiquidation(signal.entryPrice, signal.leverage, signal.side),
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        trailingStop: signal.entryPrice * (signal.side === 'long' ? 0.98 : 1.02),
        unrealizedPnl: 0,
        realizedPnl: 0,
        status: 'open',
        openTime: Date.now(),
        strategy: signal.strategy,
      };

      if (this.mode === 'live' && this.client && this.metaLoaded) {
        const result = await this.hlOpenOrder(signal);
        position.txHash = result.txHash;
        // Use fill price if available
        if (result.fillPx) position.entryPrice = result.fillPx;
      } else {
        await sleep(100);
        position.txHash = `paper_${positionId}`;
      }

      this.positions.set(positionId, position);
      this.logTrade(position, 'open');

      logger.info(
        `OPENED ${position.side.toUpperCase()} ${position.symbol}: ` +
          `$${position.sizeUsd.toFixed(2)} @ $${position.entryPrice.toFixed(2)} ` +
          `(${position.leverage}x, ${this.mode})`
      );
      return position;
    } catch (error) {
      logger.error(`Failed to open position: ${error}`);
      return null;
    }
  }

  // =============================================
  // Close Position
  // =============================================
  async closePosition(
    positionId: string,
    currentPrice: number,
    reason: 'manual' | 'stop_loss' | 'take_profit' | 'trailing_stop' | 'liquidated' = 'manual'
  ): Promise<Position | null> {
    const position = this.positions.get(positionId);
    if (!position || position.status !== 'open') {
      logger.warn(`Position ${positionId} not found or already closed`);
      return null;
    }

    try {
      position.currentPrice = currentPrice;
      position.realizedPnl = calcPnl(position, currentPrice);
      position.status = reason === 'liquidated' ? 'liquidated' : 'closed';
      position.closeTime = Date.now();

      if (this.mode === 'live' && this.client && this.metaLoaded) {
        await this.hlCloseOrder(position);
      } else {
        await sleep(50);
      }

      const action = reason === 'manual' ? 'close' : reason;
      this.logTrade(position, action as TradeLog['action']);

      logger.info(
        `CLOSED ${position.side.toUpperCase()} ${position.symbol} (${reason}): ` +
          `PnL $${position.realizedPnl.toFixed(2)} @ $${currentPrice.toFixed(2)}`
      );
      return position;
    } catch (error) {
      logger.error(`Failed to close position ${positionId}: ${error}`);
      return null;
    }
  }

  // =============================================
  // Hyperliquid: Open market order
  // =============================================
  private async hlOpenOrder(signal: TradeSignal): Promise<{ txHash: string; fillPx?: number }> {
    if (!this.client) throw new Error('Client not initialized');

    return retryWithBackoff(async () => {
      // Set leverage first
      await this.client!.updateLeverage(signal.symbol, signal.leverage, true);

      // Calculate size in tokens
      const sizeTokens = signal.positionSizeUsd / signal.entryPrice;
      const isBuy = signal.side === 'long';

      logger.info(
        `HL OPEN: ${signal.side.toUpperCase()} ${signal.symbol} | ` +
          `Size: $${signal.positionSizeUsd.toFixed(2)} (${sizeTokens.toFixed(6)} tokens) | ` +
          `Leverage: ${signal.leverage}x`
      );

      const result = await this.client!.marketOrder(
        signal.symbol,
        isBuy,
        sizeTokens,
        0.03, // 3% slippage for IOC guarantee
        false,
      );

      if (result.status !== 'ok') {
        throw new Error(`Order rejected: ${JSON.stringify(result)}`);
      }

      // Extract fill info from statuses
      const statuses = result.response?.data?.statuses || [];
      let fillPx: number | undefined;
      for (const st of statuses) {
        if (st.filled) {
          fillPx = parseFloat(st.filled.avgPx);
          logger.info(`HL fill: ${st.filled.totalSz} @ ${st.filled.avgPx}`);
        } else if (st.resting) {
          logger.info(`HL order resting (oid: ${st.resting.oid})`);
        } else if (st.error) {
          throw new Error(`HL order error: ${st.error}`);
        }
      }

      return { txHash: `hl_${Date.now()}`, fillPx };
    }, 2, 2000);
  }

  // =============================================
  // Hyperliquid: Close market order
  // =============================================
  private async hlCloseOrder(position: Position): Promise<void> {
    if (!this.client) throw new Error('Client not initialized');

    await retryWithBackoff(async () => {
      logger.info(
        `HL CLOSE: ${position.side.toUpperCase()} ${position.symbol} | ` +
          `Size: $${position.sizeUsd.toFixed(2)} | Exit: ~$${position.currentPrice.toFixed(2)}`
      );

      const result = await this.client!.marketClose(position.symbol, 0.03);

      if (result.status !== 'ok') {
        throw new Error(`Close rejected: ${JSON.stringify(result)}`);
      }

      const statuses = result.response?.data?.statuses || [];
      for (const st of statuses) {
        if (st.filled) {
          logger.info(`HL close fill: ${st.filled.totalSz} @ ${st.filled.avgPx}`);
        } else if (st.error) {
          throw new Error(`HL close error: ${st.error}`);
        }
      }
    }, 2, 2000);
  }

  // =============================================
  // Account info from Hyperliquid
  // =============================================
  async getAccountState(): Promise<HlAccountState | null> {
    if (!this.client) return null;
    try {
      return await this.client.getUserState();
    } catch {
      return null;
    }
  }

  /** Sync local positions with on-chain Hyperliquid state */
  async syncPositions(): Promise<void> {
    if (!this.client || this.mode !== 'live') return;
    try {
      const state = await this.client.getUserState();
      // Log real on-chain positions
      for (const ap of state.assetPositions) {
        const pos = ap.position;
        const szi = parseFloat(pos.szi);
        if (szi !== 0) {
          logger.info(
            `HL Position: ${pos.coin} | Size: ${pos.szi} | Entry: $${pos.entryPx} | ` +
              `uPnL: $${pos.unrealizedPnl} | Liq: $${pos.liquidationPx}`
          );
        }
      }
    } catch (e) {
      logger.error(`Failed to sync positions: ${e}`);
    }
  }

  // =============================================
  // Trade logging
  // =============================================
  private logTrade(position: Position, action: TradeLog['action']): void {
    // Hyperliquid fees: ~0.035% taker
    const feeRate = 0.00035;
    this.tradeLogs.push({
      id: generateId(),
      timestamp: Date.now(),
      symbol: position.symbol,
      side: position.side,
      action,
      price: action === 'open' ? position.entryPrice : position.currentPrice,
      size: position.size,
      sizeUsd: position.sizeUsd,
      leverage: position.leverage,
      pnl: position.realizedPnl,
      fees: position.sizeUsd * feeRate,
      strategy: position.strategy,
      txHash: position.txHash,
    });
  }

  // =============================================
  // Public accessors
  // =============================================
  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'open');
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  getTradeLogs(): TradeLog[] {
    return this.tradeLogs;
  }

  getPosition(id: string): Position | undefined {
    return this.positions.get(id);
  }

  getTradingMode(): TradingMode {
    return this.mode;
  }

  async getWalletBalance(): Promise<number> {
    if (!this.client) return 0;
    try {
      const state = await this.client.getUserState();
      const perpVal = parseFloat(state.marginSummary.accountValue);
      // In unified account mode, check spot USDC too
      if (perpVal < 1) {
        const spotState = await this.client.getSpotState();
        const usdc = spotState.balances.find(b => b.coin === 'USDC');
        return Math.max(perpVal, usdc ? parseFloat(usdc.total) : 0);
      }
      return perpVal;
    } catch {
      return 0;
    }
  }

  getSupportedMarkets(): string[] {
    return HL_COINS;
  }
}

// =============================================
// Pure utility functions
// =============================================
function calcLiquidation(entryPrice: number, leverage: number, side: Side): number {
  const mm = 0.005;
  return side === 'long'
    ? entryPrice * (1 - 1 / leverage + mm)
    : entryPrice * (1 + 1 / leverage - mm);
}

function calcPnl(position: Position, exitPrice: number): number {
  const priceChange = position.side === 'long'
    ? exitPrice - position.entryPrice
    : position.entryPrice - exitPrice;
  const pnlPct = priceChange / position.entryPrice;
  // Hyperliquid: ~0.035% taker per side
  const fees = position.sizeUsd * 0.00035 * 2;
  return pnlPct * position.sizeUsd * position.leverage - fees;
}
