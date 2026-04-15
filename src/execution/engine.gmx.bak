import { ethers } from 'ethers';
import { Position, TradeSignal, TradeLog, Side, TradingMode } from '../utils/types';
import { BotConfig } from '../utils/config';
import { logger } from '../utils/logger';
import { generateId, retryWithBackoff, sleep } from '../utils/helpers';

// =============================================
// GMX V2 Contract Addresses (Arbitrum)
// =============================================
const GMX = {
  ExchangeRouter: '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8',
  Router: '0x7452c558d45f8afC8c83dAe62C3f8A5BE19c71f6',
  OrderVault: '0x31eF83a530Fde1B38deDA89C0A6c72a85DB30487',
  DataStore: '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
  WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
};

// GMX V2 market tokens on Arbitrum
const GMX_MARKETS: Record<string, { market: string; indexToken: string }> = {
  ETH:  { market: '0x70d95587d40A2cdd56BBE18a5C87766EB8Cd45D3', indexToken: GMX.WETH },
  SOL:  { market: '0x09400D9DB990D5ed3f35D7be61DfAEB900Af03C9', indexToken: '0x2bcC6D6CdBbDC0a4071e48bb3B969b06B3330c07' },
  LINK: { market: '0x7f1fa204bb700853D36994DA19F830b6Ad18455C', indexToken: '0xf97f4df75117a78c1A5a0DBb814Af92458539FB4' },
  ARB:  { market: '0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407', indexToken: '0x912CE59144191C1204E64559FE8253a0e49E6548' },
};

// =============================================
// ABIs
// =============================================
const EXCHANGE_ROUTER_ABI = [
  'function sendWnt(address receiver, uint256 amount) external payable',
  'function createOrder(tuple(tuple(address receiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath) addresses, tuple(uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount) numbers, uint8 orderType, uint8 decreasePositionSwapType, bool isLong, bool shouldUnwrapNativeToken, bytes32 referralCode) params) external payable returns (bytes32)',
  'function multicall(bytes[] data) external payable returns (bytes[] results)',
];

// GMX order types
const ORDER_TYPE_MARKET_INCREASE = 2;
const ORDER_TYPE_MARKET_DECREASE = 4;
const SWAP_TYPE_NO_SWAP = 0;
const SWAP_TYPE_PNL_TO_COLLATERAL = 1;

// Execution fee for GMX keepers on Arbitrum (~0.001 ETH safe)
const EXECUTION_FEE = ethers.parseEther('0.001');

interface NonceManager {
  currentNonce: number;
  lastUpdate: number;
  lock: boolean;
}

export class ExecutionEngine {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet | null = null;
  private config: BotConfig;
  private nonceManager: NonceManager = { currentNonce: -1, lastUpdate: 0, lock: false };
  private positions: Map<string, Position> = new Map();
  private tradeLogs: TradeLog[] = [];
  private mode: TradingMode;
  private routerContract: ethers.Contract | null = null;
  private routerIface: ethers.Interface;

  constructor(config: BotConfig) {
    this.config = config;
    this.mode = config.tradingMode;
    this.provider = new ethers.JsonRpcProvider(config.network.rpcUrl);
    this.routerIface = new ethers.Interface(EXCHANGE_ROUTER_ABI);

    if (config.privateKey && this.mode === 'live') {
      this.wallet = new ethers.Wallet(config.privateKey, this.provider);
      this.routerContract = new ethers.Contract(
        GMX.ExchangeRouter, EXCHANGE_ROUTER_ABI, this.wallet
      );
      logger.info(`Execution engine: LIVE mode | Wallet: ${this.wallet.address}`);
    } else {
      logger.info('Execution engine: PAPER TRADING mode');
    }
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

      if (this.mode === 'live' && this.wallet) {
        position.txHash = await this.gmxOpenOrder(signal);
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

      if (this.mode === 'live' && this.wallet) {
        const txHash = await this.gmxCloseOrder(position);
        logger.info(`Close tx: ${txHash}`);
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
  // GMX V2: Submit MarketIncrease order
  // =============================================
  private async gmxOpenOrder(signal: TradeSignal): Promise<string> {
    if (!this.wallet || !this.routerContract) throw new Error('Wallet not initialized');

    const market = GMX_MARKETS[signal.symbol];
    if (!market) {
      throw new Error(`No GMX V2 market for ${signal.symbol}. Supported: ${Object.keys(GMX_MARKETS).join(', ')}`);
    }

    return retryWithBackoff(async () => {
      // Collateral = position size / leverage, denominated in ETH
      const collateralUsd = signal.positionSizeUsd / signal.leverage;

      // For non-ETH markets, we still send ETH as collateral (longToken = WETH)
      const ethPrice = signal.symbol === 'ETH' ? signal.entryPrice : await this.getEthPrice();
      const collateralEth = collateralUsd / ethPrice;
      const collateralWei = ethers.parseEther(collateralEth.toFixed(18));
      const totalValue = collateralWei + EXECUTION_FEE;

      // Verify balance
      const balance = await this.provider.getBalance(this.wallet!.address);
      if (balance < totalValue) {
        throw new Error(
          `Insufficient ETH: need ${ethers.formatEther(totalValue)}, ` +
            `have ${ethers.formatEther(balance)}`
        );
      }

      // GMX uses 30 decimals for USD values
      const sizeDeltaUsd = this.toGmxUsd(signal.positionSizeUsd);

      // Acceptable price with 1% slippage (GMX uses price * 10^12 internally)
      const slippage = 0.01;
      const acceptablePrice = signal.side === 'long'
        ? this.toGmxPrice(signal.entryPrice * (1 + slippage))
        : this.toGmxPrice(signal.entryPrice * (1 - slippage));

      // Build order params
      const addresses = {
        receiver: this.wallet!.address,
        callbackContract: ethers.ZeroAddress,
        uiFeeReceiver: ethers.ZeroAddress,
        market: market.market,
        initialCollateralToken: GMX.WETH,
        swapPath: [] as string[],
      };

      const numbers = {
        sizeDeltaUsd,
        initialCollateralDeltaAmount: 0n, // We send via sendWnt
        triggerPrice: 0n,
        acceptablePrice,
        executionFee: EXECUTION_FEE,
        callbackGasLimit: 0n,
        minOutputAmount: 0n,
      };

      const orderParams = {
        addresses,
        numbers,
        orderType: ORDER_TYPE_MARKET_INCREASE,
        decreasePositionSwapType: SWAP_TYPE_NO_SWAP,
        isLong: signal.side === 'long',
        shouldUnwrapNativeToken: false,
        referralCode: ethers.ZeroHash,
      };

      logger.info(
        `GMX V2 OPEN: ${signal.side.toUpperCase()} ${signal.symbol} | ` +
          `Size: $${signal.positionSizeUsd.toFixed(2)} | ` +
          `Collateral: ${collateralEth.toFixed(6)} ETH ($${collateralUsd.toFixed(2)}) | ` +
          `Leverage: ${signal.leverage}x`
      );

      // Encode multicall
      const sendWntData = this.routerIface.encodeFunctionData('sendWnt', [
        GMX.OrderVault,
        totalValue,
      ]);
      const createOrderData = this.routerIface.encodeFunctionData('createOrder', [orderParams]);

      const nonce = await this.getNextNonce();
      const tx = await this.routerContract!.multicall(
        [sendWntData, createOrderData],
        { value: totalValue, nonce, gasLimit: 3_000_000n }
      );

      logger.info(`GMX order tx: ${tx.hash}`);
      const receipt = await tx.wait(1);
      logger.info(`GMX order confirmed in block ${receipt!.blockNumber}`);
      return tx.hash;
    }, 2, 3000);
  }

  // =============================================
  // GMX V2: Submit MarketDecrease order (close)
  // =============================================
  private async gmxCloseOrder(position: Position): Promise<string> {
    if (!this.wallet || !this.routerContract) throw new Error('Wallet not initialized');

    const market = GMX_MARKETS[position.symbol];
    if (!market) throw new Error(`No GMX V2 market for ${position.symbol}`);

    return retryWithBackoff(async () => {
      const balance = await this.provider.getBalance(this.wallet!.address);
      if (balance < EXECUTION_FEE) {
        throw new Error(
          `Insufficient ETH for execution fee: need 0.001, ` +
            `have ${ethers.formatEther(balance)}`
        );
      }

      const sizeDeltaUsd = this.toGmxUsd(position.sizeUsd);
      const slippage = 0.01;
      const acceptablePrice = position.side === 'long'
        ? this.toGmxPrice(position.currentPrice * (1 - slippage))
        : this.toGmxPrice(position.currentPrice * (1 + slippage));

      const addresses = {
        receiver: this.wallet!.address,
        callbackContract: ethers.ZeroAddress,
        uiFeeReceiver: ethers.ZeroAddress,
        market: market.market,
        initialCollateralToken: GMX.WETH,
        swapPath: [] as string[],
      };

      const numbers = {
        sizeDeltaUsd,
        initialCollateralDeltaAmount: 0n,
        triggerPrice: 0n,
        acceptablePrice,
        executionFee: EXECUTION_FEE,
        callbackGasLimit: 0n,
        minOutputAmount: 0n,
      };

      const orderParams = {
        addresses,
        numbers,
        orderType: ORDER_TYPE_MARKET_DECREASE,
        decreasePositionSwapType: SWAP_TYPE_PNL_TO_COLLATERAL,
        isLong: position.side === 'long',
        shouldUnwrapNativeToken: true, // Get ETH back, not WETH
        referralCode: ethers.ZeroHash,
      };

      logger.info(
        `GMX V2 CLOSE: ${position.side.toUpperCase()} ${position.symbol} | ` +
          `Size: $${position.sizeUsd.toFixed(2)} | Exit: ~$${position.currentPrice.toFixed(2)}`
      );

      const sendWntData = this.routerIface.encodeFunctionData('sendWnt', [
        GMX.OrderVault,
        EXECUTION_FEE,
      ]);
      const createOrderData = this.routerIface.encodeFunctionData('createOrder', [orderParams]);

      const nonce = await this.getNextNonce();
      const tx = await this.routerContract!.multicall(
        [sendWntData, createOrderData],
        { value: EXECUTION_FEE, nonce, gasLimit: 3_000_000n }
      );

      logger.info(`GMX close tx: ${tx.hash}`);
      const receipt = await tx.wait(1);
      logger.info(`GMX close confirmed in block ${receipt!.blockNumber}`);
      return tx.hash;
    }, 2, 3000);
  }

  // =============================================
  // Helpers
  // =============================================
  /** GMX uses 30 decimal USD values */
  private toGmxUsd(usd: number): bigint {
    return ethers.parseUnits(usd.toFixed(2), 30);
  }

  /** GMX price encoding (varies by token, typically 10^12 for display prices) */
  private toGmxPrice(price: number): bigint {
    // GMX V2 stores prices as price * 10^(30 - token_decimals)
    // For WETH (18 decimals): price * 10^12
    return ethers.parseUnits(price.toFixed(2), 12);
  }

  private async getEthPrice(): Promise<number> {
    // Quick ETH price fallback from the data layer cache
    try {
      const { fetchPrice } = await import('../data/feeds');
      const data = await fetchPrice('ETH');
      return data.price;
    } catch {
      return 1600; // Safe fallback
    }
  }

  private async getNextNonce(): Promise<number> {
    while (this.nonceManager.lock) await sleep(50);
    this.nonceManager.lock = true;
    try {
      const now = Date.now();
      if (now - this.nonceManager.lastUpdate > 30000 || this.nonceManager.currentNonce < 0) {
        if (this.wallet) {
          this.nonceManager.currentNonce = await this.provider.getTransactionCount(
            this.wallet.address, 'pending'
          );
        }
        this.nonceManager.lastUpdate = now;
      } else {
        this.nonceManager.currentNonce++;
      }
      return this.nonceManager.currentNonce;
    } finally {
      this.nonceManager.lock = false;
    }
  }

  private logTrade(position: Position, action: TradeLog['action']): void {
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
      fees: position.sizeUsd * 0.0012,
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

  async getWalletBalance(): Promise<bigint> {
    if (!this.wallet) return 0n;
    return this.provider.getBalance(this.wallet.address);
  }

  getSupportedMarkets(): string[] {
    return Object.keys(GMX_MARKETS);
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
  const fees = position.sizeUsd * 0.0012; // GMX V2 ~0.06% each way
  return pnlPct * position.sizeUsd * position.leverage - fees;
}
