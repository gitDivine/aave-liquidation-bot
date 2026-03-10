# Advanced Deployment Guide

## Manual Contract Deployment (Remix IDE)

If you prefer to deploy manually instead of using `npm run deploy`:

### 1. Open Remix
- Go to [remix.ethereum.org](https://remix.ethereum.org)
- Create a new file and paste the contents of `contracts/LiquidationBot.sol`

### 2. Compile
- Solidity version: `0.8.20` or higher
- Enable optimization (200 runs)
- Click **Compile LiquidationBot.sol**

### 3. Deploy
- Environment: **Injected Provider - MetaMask**
- Make sure MetaMask is on your target chain (Base, Arbitrum, or Polygon)
- Constructor arguments:

| Chain    | `_aavePool`                                  | `_swapRouter`                                |
|----------|----------------------------------------------|----------------------------------------------|
| Base     | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Arbitrum | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |
| Polygon  | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |

- Click **Deploy** and confirm in MetaMask
- Copy the contract address into `CONTRACT_ADDRESS` in your `.env`

---

## Running 24/7 on a VPS (Ubuntu)

**1. Log into your server**
```bash
ssh root@YOUR_SERVER_IP
```

**2. Install Node.js & PM2**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

**3. Clone & install**
```bash
git clone https://github.com/gitDivine/aave-liquidation-bot.git
cd aave-liquidation-bot
npm install
```

**4. Create `.env`**
```bash
nano .env
```
Paste your environment variables. Press `Ctrl+O` to save, `Ctrl+X` to exit.

**5. Deploy the contract**
```bash
npm run deploy
```

**6. Run 24/7 with PM2**
```bash
pm2 start bot/bot.js --name "liquidator"
pm2 logs liquidator    # watch live output
pm2 save               # persist across reboots
```

---

## Telegram Notifications

Get alerts when liquidations succeed:

1. Message **@BotFather** on Telegram → `/newbot` → copy your token
2. Get your chat ID from **@userinfobot**
3. Add to `.env`:
   ```
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_CHAT_ID=your_chat_id
   ```
