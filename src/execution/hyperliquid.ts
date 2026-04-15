// =============================================
// Hyperliquid API Client — Signing & REST
// =============================================
import { ethers } from 'ethers';
import { encode } from '@msgpack/msgpack';
import axios, { AxiosInstance } from 'axios';
import { logger } from '../utils/logger';

const HL_MAINNET = 'https://api.hyperliquid.xyz';

// EIP-712 domain for L1 action signing
const PHANTOM_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
};

const PHANTOM_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
};

// =============================================
// Helpers
// =============================================
function actionHash(
  action: unknown,
  vaultAddress: string | null,
  nonce: number,
): string {
  const packed = encode(action);
  const buf: number[] = [...packed];
  // Append nonce as 8 big-endian bytes
  for (let i = 7; i >= 0; i--) buf.push((nonce >>> (i * 8)) & 0xff);
  // Vault flag
  if (!vaultAddress) {
    buf.push(0);
  } else {
    buf.push(1);
    const addr = vaultAddress.startsWith('0x') ? vaultAddress.slice(2) : vaultAddress;
    for (let i = 0; i < addr.length; i += 2) buf.push(parseInt(addr.slice(i, i + 2), 16));
  }
  return ethers.keccak256(Uint8Array.from(buf));
}

function constructPhantomAgent(hash: string) {
  return { source: 'a', connectionId: hash };
}

async function signL1Action(
  wallet: ethers.Wallet,
  action: unknown,
  vaultAddress: string | null,
  nonce: number,
): Promise<{ r: string; s: string; v: number }> {
  const hash = actionHash(action, vaultAddress, nonce);
  const phantomAgent = constructPhantomAgent(hash);

  const sig = await wallet.signTypedData(PHANTOM_DOMAIN, PHANTOM_TYPES, phantomAgent);
  const { r, s, v } = ethers.Signature.from(sig);
  return { r, s, v };
}

// =============================================
// Float / wire helpers
// =============================================
function floatToWire(x: number): string {
  const s = x.toFixed(8);
  // Remove trailing zeros but keep at least one decimal
  return parseFloat(s).toString();
}

function orderTypeToWire(tif: 'Ioc' | 'Gtc' | 'Alo') {
  return { limit: { tif } };
}

// =============================================
// Public API Client
// =============================================
export interface HlMeta {
  universe: Array<{ name: string; szDecimals: number; maxLeverage: number }>;
}

export interface HlAssetCtx {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  markPx: string;
  midPx: string | null;
  oraclePx: string;
  premium: string | null;
  impactPxs: [string, string] | null;
}

export interface HlPosition {
  coin: string;
  entryPx: string | null;
  leverage: { type: string; value: number; rawUsd: string };
  liquidationPx: string | null;
  marginUsed: string;
  positionValue: string;
  returnOnEquity: string;
  szi: string;
  unrealizedPnl: string;
  maxLeverage: number;
  cumFunding?: { allTime: string; sinceChange: string; sinceOpen: string };
}

export interface HlAccountState {
  marginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalNtlPos: string;
    totalRawUsd: string;
    totalMarginUsed: string;
  };
  assetPositions: Array<{ position: HlPosition; type: string }>;
  withdrawable: string;
  crossMaintenanceMarginUsed: string;
}

export interface HlFill {
  coin: string;
  px: string;
  sz: string;
  side: string;
  time: number;
  startPosition: string;
  dir: string;
  closedPnl: string;
  hash: string;
  oid: number;
  crossed: boolean;
  fee: string;
  feeToken: string;
  tid: number;
}

export class HyperliquidClient {
  private wallet: ethers.Wallet;
  private http: AxiosInstance;
  private meta: HlMeta | null = null;
  private nameToAsset: Map<string, number> = new Map();
  private nameToSzDecimals: Map<string, number> = new Map();
  address: string;

  constructor(privateKey: string) {
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.http = axios.create({
      baseURL: HL_MAINNET,
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ---- Info endpoints (no auth) ----

  getAvailableCoins(): string[] {
    return Array.from(this.nameToAsset.keys());
  }

  async loadMeta(): Promise<HlMeta> {
    const res = await this.http.post('/info', { type: 'meta' });
    this.meta = res.data;
    this.meta!.universe.forEach((u, i) => {
      this.nameToAsset.set(u.name, i);
      this.nameToSzDecimals.set(u.name, u.szDecimals);
    });
    logger.info(`Hyperliquid: loaded ${this.meta!.universe.length} perp markets`);
    return this.meta!;
  }

  async getAllMids(): Promise<Record<string, string>> {
    const res = await this.http.post('/info', { type: 'allMids' });
    return res.data;
  }

  async getMetaAndAssetCtxs(): Promise<[HlMeta, HlAssetCtx[]]> {
    const res = await this.http.post('/info', { type: 'metaAndAssetCtxs' });
    return res.data;
  }

  async getUserState(user?: string): Promise<HlAccountState> {
    const res = await this.http.post('/info', {
      type: 'clearinghouseState',
      user: user || this.address,
    });
    return res.data;
  }

  async getSpotState(user?: string): Promise<{ balances: Array<{ coin: string; token: number; total: string; hold: string }> }> {
    const res = await this.http.post('/info', {
      type: 'spotClearinghouseState',
      user: user || this.address,
    });
    return res.data;
  }

  /** Transfer USDC from Spot wallet → Perp wallet */
  async transferSpotToPerp(amount: number): Promise<any> {
    const nonce = Date.now();
    // The action sent to the exchange must include signatureChainId and hyperliquidChain
    // (the Python SDK mutates the action dict during signing)
    const action: Record<string, unknown> = {
      type: 'usdClassTransfer',
      amount: amount.toString(),
      toPerp: true,
      nonce,
      signatureChainId: '0x66eee',
      hyperliquidChain: 'Mainnet',
    };

    // EIP-712 user-signed action
    const domain = {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: 0x66eee, // 421614
      verifyingContract: '0x0000000000000000000000000000000000000000',
    };
    const types = {
      'HyperliquidTransaction:UsdClassTransfer': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'amount', type: 'string' },
        { name: 'toPerp', type: 'bool' },
        { name: 'nonce', type: 'uint64' },
      ],
    };
    const message = {
      hyperliquidChain: 'Mainnet',
      amount: amount.toString(),
      toPerp: true,
      nonce,
    };

    const sig = await this.wallet.signTypedData(domain, types, message);
    const { r, s, v } = ethers.Signature.from(sig);

    const payload = {
      action,
      nonce,
      signature: { r, s, v },
      vaultAddress: null,
    };

    logger.info(`Transferring $${amount} from Spot → Perp wallet...`);
    try {
      const res = await this.http.post('/exchange', payload);
      if (res.data?.status === 'ok') {
        logger.info(`Spot → Perp transfer successful: $${amount}`);
      } else {
        logger.error(`Spot → Perp transfer failed: ${JSON.stringify(res.data)}`);
      }
      return res.data;
    } catch (e: any) {
      const errData = e.response?.data;
      logger.error(`Spot → Perp transfer error: ${JSON.stringify(errData) || e.message}`);
      throw e;
    }
  }

  async getUserFills(user?: string): Promise<HlFill[]> {
    const res = await this.http.post('/info', {
      type: 'userFills',
      user: user || this.address,
    });
    return res.data;
  }

  async getCandles(coin: string, interval: string, startTime: number, endTime?: number) {
    const res = await this.http.post('/info', {
      type: 'candleSnapshot',
      req: { coin, interval, startTime, endTime: endTime || Date.now() },
    });
    return res.data;
  }

  async getFundingHistory(coin: string, startTime: number) {
    const res = await this.http.post('/info', {
      type: 'fundingHistory',
      coin,
      startTime,
    });
    return res.data;
  }

  // ---- Exchange endpoints (signed) ----

  private getAsset(coin: string): number {
    const asset = this.nameToAsset.get(coin);
    if (asset === undefined) throw new Error(`Unknown coin: ${coin}. Call loadMeta() first.`);
    return asset;
  }

  private getSzDecimals(coin: string): number {
    return this.nameToSzDecimals.get(coin) ?? 4;
  }

  /** Round size to the correct sz decimals for the coin */
  roundSize(coin: string, sz: number): number {
    const dec = this.getSzDecimals(coin);
    const factor = 10 ** dec;
    return Math.floor(sz * factor) / factor;
  }

  /** Round price to 5 significant figures */
  roundPrice(px: number): number {
    return parseFloat(px.toPrecision(5));
  }

  async updateLeverage(coin: string, leverage: number, isCross: boolean = true) {
    const action = {
      type: 'updateLeverage',
      asset: this.getAsset(coin),
      isCross,
      leverage,
    };
    return this.postAction(action);
  }

  async marketOrder(
    coin: string,
    isBuy: boolean,
    sz: number,
    slippage = 0.05,
    reduceOnly = false,
  ) {
    const mids = await this.getAllMids();
    const midPx = parseFloat(mids[coin]);
    if (!midPx || isNaN(midPx)) throw new Error(`No mid price for ${coin}`);

    const px = isBuy ? midPx * (1 + slippage) : midPx * (1 - slippage);
    const roundedPx = this.roundPrice(px);
    const roundedSz = this.roundSize(coin, sz);
    if (roundedSz <= 0) throw new Error(`Size too small for ${coin}: ${sz}`);

    const orderWire = {
      a: this.getAsset(coin),
      b: isBuy,
      p: floatToWire(roundedPx),
      s: floatToWire(roundedSz),
      r: reduceOnly,
      t: orderTypeToWire('Ioc'),
    };

    const action = {
      type: 'order',
      orders: [orderWire],
      grouping: 'na',
    };

    logger.info(
      `HL ORDER: ${isBuy ? 'BUY' : 'SELL'} ${roundedSz} ${coin} @ ${roundedPx} ` +
        `(market IOC, slippage ${(slippage * 100).toFixed(1)}%, reduceOnly=${reduceOnly})`
    );

    return this.postAction(action);
  }

  async marketClose(coin: string, slippage = 0.05) {
    const state = await this.getUserState();
    for (const ap of state.assetPositions) {
      if (ap.position.coin !== coin) continue;
      const szi = parseFloat(ap.position.szi);
      if (szi === 0) continue;
      const isBuy = szi < 0; // Close short → buy, close long → sell
      const sz = Math.abs(szi);
      return this.marketOrder(coin, isBuy, sz, slippage, true);
    }
    throw new Error(`No open position in ${coin} to close`);
  }

  // ---- Internal post with signing ----

  private async postAction(action: Record<string, unknown>) {
    const nonce = Date.now();
    const sig = await signL1Action(this.wallet, action, null, nonce);
    const payload = {
      action,
      nonce,
      signature: sig,
      vaultAddress: null,
    };

    const res = await this.http.post('/exchange', payload);
    if (res.data?.status === 'ok') {
      logger.debug(`HL action OK: ${JSON.stringify(res.data.response?.type)}`);
    } else {
      logger.error(`HL action error: ${JSON.stringify(res.data)}`);
    }
    return res.data;
  }
}
