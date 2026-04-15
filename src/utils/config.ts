import dotenv from 'dotenv';
dotenv.config();

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  gmxRouter: string;
  gmxReader: string;
  gmxDataStore: string;
  gmxExchangeRouter: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  arbitrum: {
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC || 'https://arb1.arbitrum.io/rpc',
    gmxRouter: process.env.GMX_ROUTER || '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8',
    gmxReader: process.env.GMX_READER || '0xf60becbba223EEA9495Da3f606753867eC10d139',
    gmxDataStore: process.env.GMX_DATASTORE || '0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8',
    gmxExchangeRouter: process.env.GMX_EXCHANGE_ROUTER || '0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8',
  },
  optimism: {
    name: 'Optimism',
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC || 'https://mainnet.optimism.io',
    gmxRouter: '',
    gmxReader: '',
    gmxDataStore: '',
    gmxExchangeRouter: '',
  },
  base: {
    name: 'Base',
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC || 'https://mainnet.base.org',
    gmxRouter: '',
    gmxReader: '',
    gmxDataStore: '',
    gmxExchangeRouter: '',
  },
};

export interface RiskConfig {
  maxRiskPerTrade: number;
  maxDailyLoss: number;
  maxLeverage: number;
  defaultLeverage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  trailingStopPercent: number;
}

export interface BotConfig {
  privateKey: string;
  walletAddress: string;
  network: NetworkConfig;
  tradingMode: 'live' | 'paper';
  defaultStrategy: string;
  risk: RiskConfig;
  tradingCapitalUsd: number;
  logLevel: string;
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhookUrl: string;
}

function getEnvOrThrow(key: string): string {
  const value = process.env[key];
  if (!value || value.startsWith('your_')) {
    return '';
  }
  return value;
}

function validatePrivateKey(key: string): string {
  if (!key) return '';
  // Strip 0x prefix for validation, then re-add
  const raw = key.startsWith('0x') ? key.slice(2) : key;
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'PRIVATE_KEY is not valid hex (must be 64 hex chars, 0-9 and a-f only). ' +
      'Check your .env file for typos.'
    );
  }
  return key.startsWith('0x') ? key : `0x${key}`;
}

export function loadConfig(): BotConfig {
  const networkName = process.env.DEFAULT_NETWORK || 'arbitrum';
  const network = NETWORKS[networkName];
  if (!network) {
    throw new Error(`Unknown network: ${networkName}`);
  }

  return {
    privateKey: validatePrivateKey(getEnvOrThrow('PRIVATE_KEY')),
    walletAddress: getEnvOrThrow('WALLET_ADDRESS'),
    network,
    tradingMode: (process.env.TRADING_MODE as 'live' | 'paper') || 'paper',
    defaultStrategy: process.env.DEFAULT_STRATEGY || 'trend_following',
    risk: {
      maxRiskPerTrade: parseFloat(process.env.MAX_RISK_PER_TRADE || '0.02'),
      maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || '0.05'),
      maxLeverage: parseFloat(process.env.MAX_LEVERAGE || '10'),
      defaultLeverage: parseFloat(process.env.DEFAULT_LEVERAGE || '3'),
      stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT || '0.03'),
      takeProfitPercent: parseFloat(process.env.TAKE_PROFIT_PERCENT || '0.06'),
      trailingStopPercent: parseFloat(process.env.TRAILING_STOP_PERCENT || '0.02'),
    },
    tradingCapitalUsd: parseFloat(process.env.TRADING_CAPITAL_USD || '10000'),
    logLevel: process.env.LOG_LEVEL || 'info',
    telegramBotToken: getEnvOrThrow('TELEGRAM_BOT_TOKEN'),
    telegramChatId: getEnvOrThrow('TELEGRAM_CHAT_ID'),
    discordWebhookUrl: getEnvOrThrow('DISCORD_WEBHOOK_URL'),
  };
}
