# ⚡ Aave V3 Liquidation Bot

Zero-capital liquidation bot using **Aave V3 flash loans**. Runs on **Base**, **Arbitrum**, and **Polygon**.

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/gitDivine/aave-liquidation-bot.git
cd aave-liquidation-bot
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `PRIVATE_KEY` | MetaMask → Account Details → Export Private Key |
| `ALCHEMY_HTTP_URL` | [Alchemy](https://alchemy.com) → Create App → Base → HTTPS URL |
| `ALCHEMY_WS_URL` | Same Alchemy app → WebSocket URL |
| `CHAIN` | `base`, `arbitrum`, or `polygon` |

> Your wallet needs ~$5 of ETH on your chosen chain for gas.

### 3. Deploy the Contract

```bash
npm run deploy
```

This compiles `contracts/LiquidationBot.sol`, deploys it to your selected chain with the correct Aave + Uniswap addresses, and **auto-updates** your `.env` with the contract address. No Remix needed.

### 4. Test Connection

```bash
npm test
```

Verifies your RPC, wallet, and contract are all connected correctly.

### 5. Run

```bash
npm start
```

## How It Works

```
1. Bot monitors all Aave borrowing positions via WebSocket
2. When Health Factor drops below 1.0 → position is liquidatable
3. Bot triggers your smart contract
4. Contract flash loans the debt amount (zero capital needed)
5. Contract liquidates the position, receives collateral at 5% discount
6. Contract swaps collateral back via Uniswap V3
7. Contract repays flash loan + 0.05% fee
8. Profit stays in contract — you withdraw anytime
```

## Withdrawing Profits

```bash
# See all token balances in your contract
node bot/withdraw.js

# Withdraw a specific token (e.g. USDC on Base)
node bot/withdraw.js 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CHAIN` | `base` | Target chain: `base`, `arbitrum`, or `polygon` |
| `MIN_PROFIT_USD` | `10` | Minimum profit to fire a liquidation |
| `MAX_GAS_GWEI` | `50` | Maximum gas price |
| `DRY_RUN` | `false` | Set `true` to simulate without executing |

## Multi-Chain

Deploy on multiple chains and run separate instances:

```bash
# Terminal 1 — Base
CHAIN=base node bot/bot.js

# Terminal 2 — Arbitrum
CHAIN=arbitrum ALCHEMY_WS_URL=wss://arb-mainnet.g.alchemy.com/v2/KEY ALCHEMY_HTTP_URL=https://arb-mainnet.g.alchemy.com/v2/KEY node bot/bot.js
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | ✅ | Wallet private key |
| `ALCHEMY_WS_URL` | ✅ | WebSocket RPC |
| `ALCHEMY_HTTP_URL` | ✅ | HTTP RPC |
| `CONTRACT_ADDRESS` | Auto | Filled by `npm run deploy` |
| `CHAIN` | ✅ | `base` / `arbitrum` / `polygon` |
| `MIN_PROFIT_USD` | No | Min profit threshold (default: `10`) |
| `MAX_GAS_GWEI` | No | Max gas price (default: `50`) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram alerts |
| `TELEGRAM_CHAT_ID` | No | Telegram alerts |

## Security

- Flash loans are atomic — if anything fails, nothing is lost except gas
- Contract only accepts calls from the owner (your wallet)
- Never put more ETH than needed for gas in the bot wallet
- `.env` is gitignored — your keys stay local

## Advanced Deployment

See [ADVANCED.md](ADVANCED.md) for manual Remix deployment, VPS hosting with PM2, and Telegram setup.

## License

MIT
