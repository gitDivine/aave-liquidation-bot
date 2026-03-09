# ⚡ Aave V3 Liquidation Bot

Zero-capital liquidation bot using flash loans. Runs on Base, Arbitrum, and Polygon.

---

## How It Works

1. Bot monitors all Aave borrowing positions via WebSocket
2. When a position's Health Factor drops below 1.0, it becomes liquidatable
3. Bot triggers your smart contract
4. Contract flash loans the debt amount from Aave (zero capital needed)
5. Contract liquidates the position, receives collateral at 5% discount
6. Contract swaps collateral back via Uniswap V3
7. Contract repays flash loan + 0.05% fee
8. Profit stays in contract — you withdraw anytime

---

## Prerequisites

- Node.js 18+ installed  →  https://nodejs.org
- MetaMask wallet  →  https://metamask.io
- Alchemy account (free)  →  https://alchemy.com
- ~$5 of ETH on Base (for gas)

---

## Step 1 — Deploy the Smart Contract

1. Go to **https://remix.ethereum.org**
2. Create a new file called `LiquidationBot.sol`
3. Paste the contents of `contracts/LiquidationBot.sol`
4. In the compiler tab, select **Solidity 0.8.20** and compile
5. In the Deploy tab:
   - Environment: **Injected Provider (MetaMask)**
   - Make sure MetaMask is on **Base** network
   - Constructor arguments:
     - `_aavePool`: `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`
     - `_swapRouter`: `0x2626664c2603336E57B271c5C0b26F421741e481`
6. Click **Deploy** and confirm in MetaMask (~$0.20 gas)
7. **Copy the deployed contract address** — you'll need it in Step 3

### Contract Addresses by Chain

| Chain    | Aave V3 Pool                               | Uniswap SwapRouter                         |
|----------|--------------------------------------------|--------------------------------------------|
| Base     | 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5 | 0x2626664c2603336E57B271c5C0b26F421741e481 |
| Arbitrum | 0x794a61358D6845594F94dc1DB02A252b5b4814aD | 0xE592427A0AEce92De3Edee1F18E0157C05861564 |
| Polygon  | 0x794a61358D6845594F94dc1DB02A252b5b4814aD | 0xE592427A0AEce92De3Edee1F18E0157C05861564 |

---

## Step 2 — Get Your Alchemy API Key

1. Sign up free at **https://alchemy.com**
2. Create a new app → Select **Base** as the network
3. Copy the **API Key**
4. Your URLs will be:
   - WebSocket: `wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY`
   - HTTP: `https://base-mainnet.g.alchemy.com/v2/YOUR_KEY`

---

## Step 3 — Configure the Bot

```bash
# In the liquidation-bot folder:
cp .env.example .env
```

Open `.env` and fill in:

```env
PRIVATE_KEY=<your MetaMask private key>
ALCHEMY_WS_URL=wss://base-mainnet.g.alchemy.com/v2/<your-key>
ALCHEMY_HTTP_URL=https://base-mainnet.g.alchemy.com/v2/<your-key>
CONTRACT_ADDRESS=<address from Step 1>
CHAIN=base
MIN_PROFIT_USD=10
MAX_GAS_GWEI=50
```

**How to get your private key from MetaMask:**
Account Menu → Account Details → Export Private Key

⚠️  Never share your private key or commit .env to GitHub.

---

## Step 4 — Install & Run

```bash
# Install dependencies
npm install

# Test everything is connected correctly
npm test

# Start the bot
npm start
```

---

## What You'll See

```
╔══════════════════════════════════════════════╗
║      AAVE V3 LIQUIDATION BOT — ACTIVE        ║
║      Chain: Base                             ║
║      Contract: 0x1234...                     ║
╚══════════════════════════════════════════════╝

[2026-01-15 14:32:01] ℹ️   Wallet: 0xYourWallet...
[2026-01-15 14:32:01] ℹ️   ETH Balance: 0.0041 ETH
[2026-01-15 14:32:02] ✅   Contract ownership verified ✓
[2026-01-15 14:32:05] ℹ️   Loading historical borrowers...
[2026-01-15 14:32:18] ℹ️   Active positions: 847
[2026-01-15 14:32:18] ✅   Bot is live on Base. Watching 847 positions.
[2026-01-15 14:45:33] ⚠️   Liquidatable: 0x4f3a... | HF: 0.9712
[2026-01-15 14:45:33] 💰   Processing liquidation: 0x4f3a...
[2026-01-15 14:45:34] 💰   🚀 FIRING liquidation...
[2026-01-15 14:45:36] ✅   LIQUIDATION SUCCESS! Profit: ~$47.20
```

---

## Withdrawing Profits

Profits accumulate in your contract. Withdraw anytime:

```bash
# See all token balances in your contract
node bot/withdraw.js

# Withdraw a specific token (e.g. USDC on Base)
node bot/withdraw.js 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

---

## Running 24/7 (Ubuntu VPS)

To keep the bot running 24/7 in the background without needing your laptop open, you can deploy it to a dedicated Ubuntu Virtual Private Server (VPS).

**1. Log into your Server**
Open your terminal and connect to your server via SSH:
```bash
ssh root@YOUR_SERVER_IP
```

**2. Install Node.js & PM2**
Because it's a fresh server, you need to install Node and a background process manager (`pm2`):
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

**3. Clone the Repository**
Download the open-source bot code:
```bash
git clone https://github.com/gitDivine/aave-liquidation-bot.git
cd aave-liquidation-bot
npm install
```

**4. Setup the Environment Variables**
Since the `.env` file does not upload to GitHub, you need to recreate it on the server:
```bash
nano .env
```
Paste your precise variables from your PC into this file:
```env
PRIVATE_KEY=your_metamask_key
ALCHEMY_WS_URL=wss://base-mainnet...
ALCHEMY_HTTP_URL=https://base-mainnet...
CONTRACT_ADDRESS=0x3314008F...
CHAIN=base
MIN_PROFIT_USD=10
MAX_GAS_GWEI=50
```
*(Press `CTRL+O` to save, `CTRL+X` to exit).*

**5. Run it 24/7 with PM2**
If you just type `npm start`, the bot will die when you close your SSH window. We fix this using `pm2`:
```bash
sudo npm install -g pm2
pm2 start bot/bot.js --name "liquidator"
```
To watch the bot's live output anytime:
```bash
pm2 logs liquidator
```

---

## Scaling to Multiple Chains

Deploy the same contract on Arbitrum and Polygon, then run:

```bash
# Terminal 1 — Base
CHAIN=base node bot/bot.js

# Terminal 2 — Arbitrum  
CHAIN=arbitrum ALCHEMY_WS_URL=wss://arb-mainnet.g.alchemy.com/v2/KEY node bot/bot.js

# Terminal 3 — Polygon
CHAIN=polygon ALCHEMY_WS_URL=wss://polygon-mainnet.g.alchemy.com/v2/KEY node bot/bot.js
```

---

## Optional — Telegram Notifications

Get alerts when liquidations succeed:

1. Message @BotFather on Telegram → /newbot → copy your token
2. Get your chat ID from @userinfobot
3. Add to .env:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHAT_ID=your_chat_id
   ```

---

## Security Notes

- Your private key only needs to be the deployer wallet with enough ETH for gas
- The contract only accepts calls from the owner (your wallet)
- Flash loans are atomic — if anything fails, nothing is lost except gas
- Never put more ETH in the bot wallet than you need for gas
- Test on Sepolia testnet first (change Alchemy URL to Sepolia endpoint)

---

## File Structure

```
liquidation-bot/
├── contracts/
│   └── LiquidationBot.sol      ← Deploy this in Remix IDE
├── bot/
│   ├── bot.js                  ← Main bot (npm start)
│   ├── config.js               ← Chain addresses & ABIs
│   ├── test-connection.js      ← Pre-flight check (npm test)
│   └── withdraw.js             ← Withdraw profits
├── .env.example                ← Copy to .env and fill in
├── package.json
└── README.md
```
