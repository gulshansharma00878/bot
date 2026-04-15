# Hyperliquid Perpetual Futures Trading Bot

Automated perpetual futures trading bot built for **Hyperliquid** — the highest-volume decentralized perpetual exchange with zero gas fees, 0.035% taker fees, and sub-second execution.

## Why Hyperliquid?

| Feature | Hyperliquid | GMX V2 | dYdX |
|---------|------------|--------|------|
| Gas/Keeper Fee | **$0** | ~$5/order | $0 |
| Taker Fee | **0.035%** | 0.05%+ | 0.05% |
| Execution Speed | **<1s** | ~30s | ~1s |
| Pairs | **100+** | ~15 | ~60 |
| Min Capital | **~$10** | ~$100 | ~$50 |

## Architecture

```
src/
├── index.ts                  # Main entry point & bot orchestrator
├── execution/
│   ├── engine.ts             # Position manager (open/close/track)
│   └── hyperliquid.ts        # Hyperliquid API client (signing, REST)
├── strategy/
│   ├── base.ts               # Base strategy with indicator calculations
│   ├── trendFollowing.ts     # EMA crossover + trend continuation
│   ├── meanReversion.ts      # RSI + Bollinger Bands
│   ├── fundingArbitrage.ts   # Funding rate exploitation (disabled)
│   └── index.ts              # Strategy engine
├── risk/
│   └── manager.ts            # Position sizing, SL/TP, circuit breaker
├── data/
│   ├── feeds.ts              # CoinGecko price feeds, OHLCV
│   └── aggregator.ts         # Multi-symbol data aggregation
├── dashboard/
│   ├── server.ts             # Express web dashboard API
│   └── template.ts           # Real-time dashboard UI
├── backtest/
│   ├── engine.ts             # Backtest simulation engine
│   └── runner.ts             # CLI runner with CSV export
├── notifications/
│   └── service.ts            # Telegram + Discord alerts
└── utils/
    ├── config.ts             # Environment config loader
    ├── types.ts              # TypeScript type definitions
    ├── logger.ts             # Winston structured logging
    └── helpers.ts            # Utilities (retry, formatting)
```

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your private key and settings
```

Key env vars:
- `PRIVATE_KEY` — Your wallet private key (same key you use on Hyperliquid)
- `TRADING_MODE` — `paper` (simulated) or `live` (real trades)
- `TRADING_CAPITAL_USD` — Starting capital for position sizing (e.g., `40`)
- `DEFAULT_NETWORK` — `hyperliquid` (default)

### 3. Build
```bash
npm run build
```

### 4. Paper trading (simulated, no real funds)
```bash
npm run start:paper
```

### 5. Live trading (REAL FUNDS)
```bash
npm run start:live
```

### 6. Run from compiled JS (production)
```bash
npm run start:dist:live
```

### 7. Backtest (no wallet needed)
```bash
npm run backtest
```

## Dashboard

The bot includes a real-time web dashboard at `http://localhost:3000` with:

- **Live account balance** from Hyperliquid (account value, margin, withdrawable)
- **Market prices** with 24h change, funding rates, volume, open interest
- **Open positions** with entry, PnL, stop loss, take profit, liquidation price
- **Equity curve** chart
- **Trade history** table
- **Risk metrics** — win rate, profit factor, best/worst trade, total fees
- **Circuit breaker** status
- Auto-refreshes every 5 seconds

## Trading Strategies

### 1. Trend Following (`trend_following`) — Active
- EMA(9) crosses EMA(21) + trend continuation entries
- Requires 1% EMA separation + price near fast EMA for pullback
- Stop loss: 3x ATR | Take profit: 4.5x ATR
- Best in: Trending markets

### 2. Mean Reversion (`mean_reversion`) — Active
- RSI extremes + Bollinger Band touch + RSI reversal
- Stop loss: 1.5x ATR | Take profit: BB middle band
- Best in: Range-bound, choppy markets

### 3. Funding Arbitrage (`funding_arbitrage`) — Disabled
- Disabled because the data feed uses simulated funding rates
- Can be re-enabled when connected to real funding rate sources

## Risk Management

| Parameter | Default | Description |
|-----------|---------|-------------|
| Max risk per trade | 2% | Capital at risk per position |
| Daily loss limit | 5% | Circuit breaker halts all trading |
| Max leverage | 10x | Hard cap |
| Default leverage | 3x | Volatility-adjusted |
| Stop loss | ATR-based | Dynamic per strategy |
| Trailing stop | 2% | Follows price upward |
| Max positions | 5 | Concurrent open positions |
| Confidence threshold | 0.55 | Minimum signal quality |
| Trade cooldown | 15 min | Per-symbol cooldown after close |

## Cost Comparison ($40 capital, 5x leverage, $200 position)

| | Round Trip Cost | Move to Breakeven |
|---|---|---|
| **Hyperliquid** | **$0.14** | **0.07%** |
| Vertex | $0.20 | 0.10% |
| gTrade | $0.32 | 0.16% |
| GMX V2 | $5.25 | 2.50% |

## Deployment on Render

The repo includes a `render.yaml` blueprint:

1. Create a **Web Service** on Render
2. Connect your GitHub repo
3. Build command: `npm install && npm run build`
4. Start command: `npm run start:dist:live`
5. Add env vars in Render dashboard: `PRIVATE_KEY`, `TRADING_MODE`, `TRADING_CAPITAL_USD`, etc.

## Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript |
| `npm run clean` | Remove dist/ |
| `npm run rebuild` | Clean + build |
| `npm run start` | Run with ts-node |
| `npm run start:live` | Live trading (ts-node) |
| `npm run start:paper` | Paper trading (ts-node) |
| `npm run start:dist` | Run compiled JS |
| `npm run start:dist:live` | Run compiled JS in live mode |
| `npm run backtest` | Run backtester |
| `npm run typecheck` | Type-check without emit |
| `npm run logs` | Tail log files |

## Important Notes

- **Bridge USDC to Hyperliquid** before live trading: Use the [Hyperliquid bridge](https://app.hyperliquid.xyz) to deposit USDC from Arbitrum
- **Collateral is USDC** — Hyperliquid uses USDC as margin, not ETH
- **Same private key** as your Hyperliquid wallet
- **Paper mode** uses the same Hyperliquid API for market data but simulates trades locally
- Logs are written to `logs/` directory

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
