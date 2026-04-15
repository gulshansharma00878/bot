# DEX Perpetual Futures Trading Bot

Production-ready perpetual futures trading bot for Ethereum Layer 2 networks (Arbitrum, Optimism, Base). Connects to GMX V2 and similar DEX perps protocols.

## Architecture

```
src/
├── index.ts              # Main entry point & bot orchestrator
├── strategy/             # Trading strategies
│   ├── base.ts           # Base strategy with indicator calculations
│   ├── trendFollowing.ts # EMA crossover + volume + multi-TF
│   ├── meanReversion.ts  # RSI + Bollinger Bands
│   ├── fundingArbitrage.ts # Funding rate exploitation
│   └── index.ts          # Strategy engine (manages all strategies)
├── execution/
│   └── engine.ts         # Web3 execution, paper trading, nonce mgmt
├── risk/
│   └── manager.ts        # Position sizing, SL/TP, circuit breaker
├── data/
│   ├── feeds.ts          # CoinGecko price feeds, OHLCV, funding
│   └── aggregator.ts     # Multi-symbol data aggregation
├── backtest/
│   ├── engine.ts         # Backtest simulation engine
│   └── runner.ts         # CLI runner, CSV export, charts
├── notifications/
│   └── service.ts        # Telegram + Discord alerts
└── utils/
    ├── config.ts         # Environment config loader
    ├── types.ts          # TypeScript type definitions
    ├── logger.ts         # Winston structured logging
    └── helpers.ts        # Utilities (retry, formatting, etc.)
```

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your settings
```

### 3. Run backtest (no wallet needed)
```bash
npm run backtest
```

### 4. Paper trading (simulated, no real funds)
```bash
npm run start:paper
```

### 5. Live trading (REAL FUNDS — use with caution)
```bash
npm run start:live
```

## Strategies

### 1. Trend Following (`trend_following`)
- **Entry**: EMA(9) crosses EMA(21) with above-average volume
- **Filter**: Multi-timeframe alignment (1h, 4h, 1d must agree)
- **Stop loss**: 2x ATR below/above entry
- **Take profit**: 3x ATR from entry
- **Best in**: Trending markets with clear directional momentum

### 2. Mean Reversion (`mean_reversion`)
- **Entry**: Price touches Bollinger Band + RSI at extremes + RSI turning
- **Filter**: Skips signals that oppose the higher-timeframe trend
- **Stop loss**: 1.5x ATR (tighter — mean reversion expects quick moves)
- **Take profit**: Middle Bollinger Band (the mean)
- **Best in**: Range-bound, choppy markets

### 3. Funding Rate Arbitrage (`funding_arbitrage`)
- **Entry**: Funding rate exceeds 0.05% threshold
- **Logic**: Short when funding is highly positive (collect from longs), long when negative
- **Confirmation**: Open interest imbalance must align
- **Stop loss**: 3x ATR (wider — tolerates volatility to collect funding)
- **Best in**: High funding regimes (liquidation cascades, one-sided positioning)

## Risk Management

| Parameter | Default | Description |
|-----------|---------|-------------|
| Max risk per trade | 2% | Maximum capital at risk per position |
| Daily loss limit | 5% | Circuit breaker — halts trading for the day |
| Max leverage | 10x | Hard cap on leverage |
| Default leverage | 3x | Volatility-adjusted (lower vol → higher leverage) |
| Stop loss | ATR-based | Dynamic, per strategy |
| Trailing stop | 2% | Follows price to lock in profits |
| Max positions | 5 | Concurrent open positions limit |
| Position sizing | ATR-based | Size inversely proportional to volatility |

### Circuit Breaker
When daily PnL drops below the daily loss limit (-5% default), **all new trades are blocked** until the next calendar day. This prevents emotional/revenge trading and catastrophic drawdowns.

### Liquidation Monitoring
Every cycle, the bot checks how close each position is to liquidation. If within 2% of the liquidation price, the position is auto-closed to prevent forced liquidation and associated penalties.

## Backtest Output

Running `npm run backtest` produces:
- Console output with PnL, Sharpe ratio, max drawdown, win rate
- ASCII equity curve chart
- Strategy comparison table
- CSV files in `backtest_results/`:
  - `*_trades.csv` — every trade with entry/exit/pnl
  - `*_equity.csv` — equity curve over time

### Sample Expected Output
```
============================================================
          BACKTEST RESULTS
============================================================
Strategy:           trend_following
Symbol:             ETH
Period:             2025-04-14 → 2026-04-14
------------------------------------------------------------
Initial Capital:    $10,000
Final Capital:      $11,247
Total PnL:          $1,247.32 (12.47%)
------------------------------------------------------------
Total Trades:       47
Win Rate:           48.9%
Avg Win:            $89.42
Avg Loss:           $52.18
Profit Factor:      1.42
------------------------------------------------------------
Sharpe Ratio:       1.23
Max Drawdown:       $824.55 (7.85%)
Avg Holding Period: 18.4 hours
============================================================
```

## Environment Variables

See [.env.example](.env.example) for the full list. Key settings:

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Live only | Wallet private key (never commit!) |
| `TRADING_MODE` | No | `paper` (default) or `live` |
| `DEFAULT_NETWORK` | No | `arbitrum`, `optimism`, or `base` |
| `DEFAULT_STRATEGY` | No | `trend_following`, `mean_reversion`, or `funding_arbitrage` |
| `TRADING_CAPITAL_USD` | No | Starting capital (default: 10000) |
| `TELEGRAM_BOT_TOKEN` | No | For trade notifications |
| `DISCORD_WEBHOOK_URL` | No | For trade notifications |

## Safety

- **Paper mode by default** — set `TRADING_MODE=paper` or omit the variable
- **Live mode requires explicit `--mode live` CLI flag** as a double-check
- **Private keys are NEVER logged** and only read from `.env`
- `.env` is gitignored
- Circuit breaker prevents runaway losses
- All strategies have mandatory stop losses

## Gas Optimization (L2)

- Uses `maxFeePerGas` with a 20% buffer (L2 fees are minimal but spikes happen)
- Nonce management with local cache + periodic chain refresh
- Retry logic with exponential backoff for failed transactions
- Batched multicall where supported (GMX V2 Exchange Router)

## Extending

### Add a new strategy
1. Create `src/strategy/myStrategy.ts` extending `BaseStrategy`
2. Implement the `analyze(state: MarketState)` method
3. Register in `src/strategy/index.ts` constructor
4. Add the strategy name to the `StrategyName` type in `types.ts`

### Add a new protocol
1. Add contract addresses to network config in `src/utils/config.ts`
2. Implement protocol-specific order creation in `src/execution/engine.ts`
3. Add data feed functions in `src/data/feeds.ts`

## License

ISC
