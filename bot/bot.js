// ============================================================
//  MULTI-PROTOCOL LIQUIDATION BOT — MAIN SCRIPT
//  Supports: Aave V3, Compound V3, Moonwell
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const { execSync } = require("child_process");
const { CONTRACT_ADDRESS, CHAINS, PROTOCOLS, BOT_CONTRACT_ABI } = require("./config");

// Adapters
const AaveV3Adapter = require("./protocols/AaveV3Adapter");
const CompoundV3Adapter = require("./protocols/CompoundV3Adapter");
const MoonwellAdapter = require("./protocols/MoonwellAdapter");

function autoUpdate() {
  try {
    const pullResultRaw = execSync("git pull", { encoding: "utf8", timeout: 15000 });
    const pullResult = pullResultRaw.trim();
    if (!pullResult.toLowerCase().includes("up to date")) {
      execSync("npm install --omit=dev", { encoding: "utf8", timeout: 30000 });
      process.exit(0);
    }
  } catch { }
}
autoUpdate();

// ── Load & Validate Config ───────────────────────────────────
const CHAIN = process.env.CHAIN || "base";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const HTTP_URL = process.env.ALCHEMY_HTTP_URL || "https://mainnet.base.org";
const WS_URL = process.env.ALCHEMY_WS_URL || "wss://mainnet.base.org/ws";
const CONTRACT_ADDR = CONTRACT_ADDRESS;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "10");
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "50");

const PUBLIC_RPCS = [
  "https://mainnet.base.org",
  "https://base.publicnode.com",
  "https://1rpc.io/base"
];

async function validateRpc() {
  const probe = async (url) => {
    try {
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      await Promise.race([
        p.getNetwork(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
      ]);
      return p;
    } catch (err) {
      log.warn(`Probe failed for ${url.split('//')[1]?.split('/')[0] || url}: ${err.message.slice(0, 50)}`);
      return null;
    }
  };

  log.info("Validating RPC infrastructure...");

  // 1. Try Primary (Alchemy/User Config)
  const primary = await probe(HTTP_URL);
  if (primary) {
    httpProvider = primary;
    log.success("Primary RPC connected ✓");
    return;
  }

  // 2. Rotate through Public Fallbacks
  log.warn("Primary RPC failed. Cycling through public fallbacks...");
  for (const rpc of PUBLIC_RPCS) {
    const fallback = await probe(rpc);
    if (fallback) {
      httpProvider = fallback;
      log.success(`Connected to public fallback: ${rpc.split('//')[1]?.split('/')[0]} ✓`);
      return;
    }
  }

  log.error("CRITICAL: All RPC providers failed. Retrying with first public node anyway...");
  httpProvider = new ethers.JsonRpcProvider(PUBLIC_RPCS[0], undefined, { staticNetwork: true });
}

let wallet;
let botContract;

async function setupWallet() {
  await validateRpc();
  wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
  botContract = new ethers.Contract(CONTRACT_ADDR, BOT_CONTRACT_ABI, wallet);
}

// ── Global Error Handlers ────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes("429") || msg.includes("limit exceeded")) {
    log.error(`RPC 429 detected (Rejection). PM2 will restart.`);
    process.exit(1);
  }
  log.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  if (err.message.includes("429") || err.message.includes("limit exceeded")) {
    log.error(`RPC 429 detected (Exception). PM2 will restart.`);
    process.exit(1);
  }
  log.error("Uncaught Exception:", err);
  process.exit(1);
});

// ── State ────────────────────────────────────────────────────
const watchedUsers = new Map(); // address → { hf, debt, collateral, protocol }
const liquidating = new Set();
const adapters = [];
let totalProfit = 0;
let liquidationCount = 0;
let isScanning = false;

const log = {
  info: (...m) => console.log(`[${new Date().toISOString()}] ℹ️  `, ...m),
  success: (...m) => console.log(`[${new Date().toISOString()}] ✅  `, ...m),
  warn: (...m) => console.log(`[${new Date().toISOString()}] ⚠️  `, ...m),
  error: (...m) => console.error(`[${new Date().toISOString()}] ❌  `, ...m),
  money: (...m) => console.log(`[${new Date().toISOString()}] 💰  `, ...m),
};

// ── Initialize Adapters ──────────────────────────────────────
function initAdapters() {
  adapters.push(new AaveV3Adapter(httpProvider, PROTOCOLS.aaveV3));
  adapters.push(new CompoundV3Adapter(httpProvider, PROTOCOLS.compoundV3));
  adapters.push(new MoonwellAdapter(httpProvider, PROTOCOLS.moonwell));
}

// ── Main Loop ────────────────────────────────────────────────
async function scanPositions() {
  if (isScanning) return;
  isScanning = true;

  try {
    for (const adapter of adapters) {
      const users = Array.from(watchedUsers.entries()).filter(([_, data]) => data.protocol === adapter.name);
      if (users.length === 0) continue;

      log.info(`Scanning ${users.length} users on ${adapter.name}...`);
      for (const [key, data] of users) {
        try {
          const updated = await adapter.getUserData(data.address);
          watchedUsers.set(key, { ...data, ...updated, lastChecked: Date.now() });

          if (updated.healthFactor < 1.0 && !liquidating.has(data.address)) {
            await processLiquidation(data.address, adapter);
          }
        } catch (e) {
          // Silent or low-level log
        }
      }
    }
  } finally {
    isScanning = false;
  }
}

async function processLiquidation(user, adapter) {
  if (liquidating.has(user)) return;
  liquidating.add(user);
  log.money(`Attempting liquidation: ${user} on ${adapter.name}`);

  try {
    const params = await adapter.identifyLiquidationPair(user);
    if (!params.debtAsset || !params.collateralAsset) return;

    // Fire transaction
    const tx = await botContract.execute(
      params.collateralAsset,
      params.debtAsset,
      user,
      params.debtAmount,
      3000, // pool fee
      adapter.type,
      params.protocolAddress,
      { gasLimit: 1_200_000 }
    );

    log.info(`TX Sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      liquidationCount++;
      log.success(`Liquidation successful! Protocol: ${adapter.name}`);
      await notify(`✅ Liquidation on ${adapter.name} successful!\nTarget: ${user}\nTX: ${tx.hash}`);
    }
  } catch (err) {
    log.error(`Liquidation failed: ${err.message}`);
  } finally {
    liquidating.delete(user);
  }
}

async function notify(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
  } catch { }
}

async function main() {
  await setupWallet();
  initAdapters();
  log.info(`Starting Multi-Protocol Bot on ${CHAIN}...`);

  // Seed watchlist
  const rpcList = [HTTP_URL, ...PUBLIC_RPCS];
  for (const adapter of adapters) {
    try {
      log.info(`Seeding ${adapter.name} watchlist (scanning last 2000 blocks)...`);
      const { users, lastWorkingRpc } = await adapter.getWatchlistSeed(rpcList, 2000);

      // Update global provider if adapter switched to a better RPC
      if (lastWorkingRpc && lastWorkingRpc !== httpProvider.rpcConfig.url) {
        log.info(`Updating global provider to: ${lastWorkingRpc.split('//')[1].split('/')[0]}`);
        httpProvider = new ethers.JsonRpcProvider(lastWorkingRpc, undefined, { staticNetwork: true });
        wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
        botContract = new ethers.Contract(CONTRACT_ADDR, BOT_CONTRACT_ABI, wallet);
      }

      let count = 0;
      for (const user of users) {
        const key = `${adapter.name}:${user}`;
        if (!watchedUsers.has(key)) {
          watchedUsers.set(key, { protocol: adapter.name, address: user, lastChecked: 0 });
          count++;
        }
      }
      log.success(`Seeded ${count} new users from ${adapter.name}.`);
    } catch (err) {
      log.warn(`Seeding failed for ${adapter.name}: ${err.message}`);
    }
  }

  log.info(`Final Watchlist: ${watchedUsers.size} users across all protocols.`);
  await notify(`🤖 Liquidation Bot Started!\n⛓ Chain: ${CHAIN}\n👁 Watching: ${watchedUsers.size} users`);

  setInterval(scanPositions, 60_000);
  scanPositions();

  // ── Hourly Telegram heartbeat + 10-min update checks ──
  let heartbeatTick = 0;
  setInterval(async () => {
    heartbeatTick++;

    // Every 40 ticks × 15s = 10 minutes — check for updates
    if (heartbeatTick % 40 === 0) {
      try {
        const result = execSync("git pull", { encoding: "utf8", timeout: 15000 }).trim();
        if (result !== "Already up to date." && result !== "Already up-to-date.") {
          log.info(`[Update] New code pulled: ${result}`);
          await notify(`🔄 Update found — restarting bot...`);
          execSync("npm install --omit=dev", { encoding: "utf8", timeout: 30000 });
          process.exit(0); // PM2 will auto-restart with new code
        }
      } catch { }
    }

    // 240 ticks × 15s = 1 hour — Telegram heartbeat
    if (heartbeatTick % 240 === 0) {
      try {
        const currentBal = await httpProvider.getBalance(wallet.address);
        await notify(
          `💓 Liquidation Bot Alive\n` +
          `⏱ Uptime: ${Math.floor(heartbeatTick / 240)}h\n` +
          `👁 Watching: ${watchedUsers.size} users\n` +
          `💰 Successes: ${liquidationCount}\n` +
          `🔋 ETH: ${parseFloat(ethers.formatEther(currentBal)).toFixed(4)}`
        );
      } catch { }
    }
  }, 15_000);
}

main().catch(e => log.error("Fatal:", e.message));
