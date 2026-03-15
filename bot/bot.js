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
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "2");
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "50");

const PUBLIC_RPCS = [
  "https://mainnet.base.org",
  "https://base.publicnode.com",
  "https://1rpc.io/base"
];

let httpProvider;
let workingRpcUrl;

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
    return HTTP_URL;
  }

  // 2. Rotate through Public Fallbacks
  log.warn("Primary RPC failed. Cycling through public fallbacks...");
  for (const rpc of PUBLIC_RPCS) {
    const fallback = await probe(rpc);
    if (fallback) {
      httpProvider = fallback;
      log.success(`Connected to public fallback: ${rpc.split('//')[1]?.split('/')[0]} ✓`);
      return rpc;
    }
  }

  log.error("CRITICAL: All RPC providers failed. Retrying with first public node anyway...");
  httpProvider = new ethers.JsonRpcProvider(PUBLIC_RPCS[0], undefined, { staticNetwork: true });
  return PUBLIC_RPCS[0];
}

let wallet;
let botContract;

async function setupWallet() {
  workingRpcUrl = await validateRpc();
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

async function seedWatchlist(blocksBack = 10000) {
  log.info(`Discovering new borrowers (scanning last ${blocksBack} blocks)...`);
  let newUsersCount = 0;

  for (const adapter of adapters) {
    try {
      // Recalculate working list so we don't restart on dead RPCs
      const rpcList = [workingRpcUrl, ...PUBLIC_RPCS.filter(r => r !== workingRpcUrl)];
      const { users, lastWorkingRpc } = await adapter.getWatchlistSeed(rpcList, blocksBack);

      // Update global provider if adapter switched to a better RPC
      if (lastWorkingRpc && lastWorkingRpc !== workingRpcUrl) {
        log.info(`Updating global provider to: ${lastWorkingRpc.split('//')[1].split('/')[0]}`);
        workingRpcUrl = lastWorkingRpc;
        httpProvider = new ethers.JsonRpcProvider(workingRpcUrl, undefined, { staticNetwork: true });
        wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
        botContract = new ethers.Contract(CONTRACT_ADDR, BOT_CONTRACT_ABI, wallet);
      }

      for (const user of users) {
        const key = `${adapter.name}:${user}`;
        if (!watchedUsers.has(key)) {
          watchedUsers.set(key, { protocol: adapter.name, address: user, lastChecked: 0 });
          newUsersCount++;
        }
      }
    } catch (err) {
      log.warn(`Discovery failed for ${adapter.name}: ${err.message}`);
    }
  }

  if (newUsersCount > 0) {
    log.success(`Added ${newUsersCount} new users to watchlist. Total: ${watchedUsers.size}`);
  } else {
    log.info(`No new users found. Watchlist remains at ${watchedUsers.size}`);
  }
}

async function main() {
  await setupWallet();
  initAdapters();
  log.info(`Starting Multi-Protocol Bot on ${CHAIN}...`);

  // 1. Initial Deep Scan (24h history)
  await seedWatchlist(50000);

  log.info(`Final Watchlist: ${watchedUsers.size} users across all protocols.`);
  await notify(`🤖 Liquidation Bot Started!\n⛓ Chain: ${CHAIN}\n👁 Watching: ${watchedUsers.size} users`);

  // 2. Start Scan Cycle (Health Checks)
  setInterval(scanPositions, 60_000);
  scanPositions();

  // 3. 1-hour rolling discovery (Discover new borrowers)
  setInterval(() => seedWatchlist(15000), 3600_000);

  // 4. 10-minute auto-update checks
  setInterval(async () => {
    try {
      const result = execSync("git pull", { encoding: "utf8", timeout: 15000 }).trim();
      if (result !== "Already up to date." && result !== "Already up-to-date.") {
        log.info(`[Update] New code pulled: ${result}`);
        await notify(`🔄 Update found — restarting bot...`);
        execSync("npm install --omit=dev", { encoding: "utf8", timeout: 30000 });
        process.exit(0);
      }
    } catch { }
  }, 600_000);
}

main().catch(e => log.error("Fatal:", e.message));
