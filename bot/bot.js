// ============================================================
//  AAVE V3 LIQUIDATION BOT — MAIN SCRIPT
//  Run with: node bot/bot.js
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const { execSync } = require("child_process");
const { CHAINS, AAVE_POOL_ABI, ERC20_ABI, BOT_CONTRACT_ABI } = require("./config");

function autoUpdate() {
  try {
    console.log("[Update] Checking for updates...");
    const pullResult = execSync("git pull", { encoding: "utf8", timeout: 15000 }).trim();
    console.log(`[Update] ${pullResult}`);
    if (pullResult !== "Already up to date." && pullResult !== "Already up-to-date.") {
      console.log("[Update] New code pulled — installing dependencies...");
      execSync("npm install --omit=dev", { encoding: "utf8", timeout: 30000 });
      console.log("[Update] Dependencies updated ✓");
    }
  } catch (err) {
    console.warn("[Update] Auto-update skipped:", err.message);
  }
}

autoUpdate();

const WATCHLIST_FILE = "./watchlist.json";

// Load saved watchlist from disk on startup
function loadWatchlist() {
  try {
    if (fs.existsSync(WATCHLIST_FILE)) {
      const saved = JSON.parse(fs.readFileSync(WATCHLIST_FILE, "utf8"));
      for (const [addr, data] of Object.entries(saved)) {
        watchedUsers.set(addr, data);
      }
      log.info(`Loaded ${watchedUsers.size} saved positions from disk`);
    }
  } catch { log.warn("Could not load saved watchlist — starting fresh"); }
}

// Save watchlist to disk
function saveWatchlist() {
  try {
    const obj = Object.fromEntries(watchedUsers);
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(obj, null, 2));
  } catch { }
}

// ── Load & Validate Config ───────────────────────────────────
const CHAIN = process.env.CHAIN || "base";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const WS_URL = process.env.ALCHEMY_WS_URL;
const HTTP_URL = process.env.ALCHEMY_HTTP_URL;
const CONTRACT_ADDR = process.env.CONTRACT_ADDRESS;
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "10");
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "50");

// Validate all required config
const missing = [];
if (!PRIVATE_KEY) missing.push("PRIVATE_KEY");
if (!WS_URL) missing.push("ALCHEMY_WS_URL");
if (!HTTP_URL) missing.push("ALCHEMY_HTTP_URL");
if (!CONTRACT_ADDR) missing.push("CONTRACT_ADDRESS");
if (missing.length) {
  console.error(`\n❌  Missing required .env values: ${missing.join(", ")}`);
  console.error("    Copy .env.example to .env and fill in your values.\n");
  process.exit(1);
}

const chainConfig = CHAINS[CHAIN];
if (!chainConfig) {
  console.error(`❌  Unknown chain: "${CHAIN}". Use: base | arbitrum | polygon`);
  process.exit(1);
}

// ── Providers & Contracts ────────────────────────────────────
const httpProvider = new ethers.JsonRpcProvider(HTTP_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
const aavePool = new ethers.Contract(chainConfig.aavePool, AAVE_POOL_ABI, httpProvider);
const botContract = new ethers.Contract(CONTRACT_ADDR, BOT_CONTRACT_ABI, wallet);

// ── State ────────────────────────────────────────────────────
const watchedUsers = new Map(); // address → { hf, debt, collateral }
const liquidating = new Set(); // addresses currently being liquidated
let wsProvider = null;
let totalProfit = 0;
let liquidationCount = 0;
let scanCount = 0;

// ── Logging Helpers ──────────────────────────────────────────
const log = {
  info: (...m) => console.log(`[${ts()}] ℹ️  `, ...m),
  success: (...m) => console.log(`[${ts()}] ✅  `, ...m),
  warn: (...m) => console.log(`[${ts()}] ⚠️  `, ...m),
  error: (...m) => console.error(`[${ts()}] ❌  `, ...m),
  money: (...m) => console.log(`[${ts()}] 💰  `, ...m),
  scan: (...m) => console.log(`[${ts()}] 👁️  `, ...m),
};
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

// ── ETH Price Feed (Chainlink-style via Uniswap TWAP fallback) ─
let ethPriceUSD = 3000; // fallback default

async function refreshEthPrice() {
  try {
    // Use a free public API for ETH price
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    const data = await res.json();
    if (data?.ethereum?.usd) {
      ethPriceUSD = data.ethereum.usd;
    }
  } catch {
    // Keep using last known price — non-critical
  }
}

// ── Get all active Aave borrowers ────────────────────────────
// Listens to Borrow events to build a list of users to watch
async function startEventListening() {
  try {
    wsProvider = new ethers.WebSocketProvider(WS_URL);

    // Event signature for Aave V3 Borrow
    const borrowTopic = ethers.id("Borrow(address,address,address,uint256,uint8,uint256,uint16)");
    const supplyTopic = ethers.id("Supply(address,address,address,uint256,uint16)");

    log.info(`Listening for new Borrow/Supply events on ${chainConfig.name}...`);

    // Watch for new borrows — add these users to our watchlist
    wsProvider.on({ address: chainConfig.aavePool, topics: [borrowTopic] }, async (log_) => {
      try {
        const user = "0x" + log_.topics[2].slice(26); // extract user from topic
        addToWatchlist(user.toLowerCase());
      } catch { }
    });

    // Handle WebSocket disconnection — auto-reconnect
    wsProvider.websocket.on("close", () => {
      log.warn("WebSocket disconnected. Reconnecting in 5 seconds...");
      setTimeout(startEventListening, 5000);
    });

  } catch (err) {
    log.error("WebSocket connection failed:", err.message);
    log.warn("Retrying in 10 seconds...");
    setTimeout(startEventListening, 10000);
  }
}

// ── Add user to watchlist ────────────────────────────────────
async function addToWatchlist(user) {
  if (watchedUsers.has(user)) return;
  try {
    const data = await aavePool.getUserAccountData(user);
    const hf = Number(ethers.formatUnits(data.healthFactor, 18));
    // Only watch users who actually have debt
    if (data.totalDebtBase > 0n) {
      watchedUsers.set(user, {
        healthFactor: hf,
        totalDebt: data.totalDebtBase,
        totalCollateral: data.totalCollateralBase,
        lastChecked: Date.now()
      });
      saveWatchlist();
    }
  } catch { }
}

// ── Scan all watched users for liquidation opportunities ─────
async function scanPositions() {
  if (watchedUsers.size === 0) return;

  scanCount++;
  const users = Array.from(watchedUsers.keys());
  const liquidatable = [];

  // Check each user's health factor
  for (const user of users) {
    try {
      const data = await aavePool.getUserAccountData(user);
      const hf = Number(ethers.formatUnits(data.healthFactor, 18));

      // Update stored data
      watchedUsers.set(user, {
        healthFactor: hf,
        totalDebt: data.totalDebtBase,
        totalCollateral: data.totalCollateralBase,
        lastChecked: Date.now()
      });

      // Remove users with no debt (they repaid)
      if (data.totalDebtBase === 0n) {
        watchedUsers.delete(user);
        saveWatchlist();
        continue;
      }

      // Flag as liquidatable if HF < 1.0
      if (hf < 1.0 && !liquidating.has(user)) {
        liquidatable.push({ user, hf, data });
        log.warn(`Liquidatable: ${user} | HF: ${hf.toFixed(4)} | Debt: $${formatBase(data.totalDebtBase)}`);
      }
      // Warn if approaching (early warning)
      else if (hf < 1.05 && hf >= 1.0) {
        log.warn(`Approaching: ${user} | HF: ${hf.toFixed(4)} — watching closely`);
      }

    } catch { }
  }

  // Process all liquidatable positions
  for (const position of liquidatable) {
    await processLiquidation(position);
  }

  // Print scan summary every 10 scans
  if (scanCount % 10 === 0) {
    log.scan(`Watching ${watchedUsers.size} positions | ${liquidationCount} liquidations | $${totalProfit.toFixed(2)} earned`);
  }
}

// ── Core Liquidation Logic ───────────────────────────────────
async function processLiquidation({ user, hf, data }) {
  log.money(`Processing liquidation: ${user}`);

  try {
    // ── Step 1: Identify the best debt + collateral pair ──────
    const { debtAsset, collateralAsset, debtAmount } = await findBestLiquidationPair(user);
    if (!debtAsset || !collateralAsset) {
      log.warn(`Could not find valid liquidation pair for ${user}`);
      return;
    }

    // ── Step 2: Estimate profit ───────────────────────────────
    const debtAmountNum = Number(ethers.formatUnits(debtAmount, 6)); // assume USDC=6 decimals
    const estimatedBonus = debtAmountNum * 0.05; // 5% liquidation bonus
    const gasCostUSD = await estimateGasCostUSD();

    log.info(`  Debt to cover: $${debtAmountNum.toFixed(2)}`);
    log.info(`  Expected bonus: $${estimatedBonus.toFixed(2)}`);
    log.info(`  Gas cost: ~$${gasCostUSD.toFixed(2)}`);

    const estimatedProfit = estimatedBonus - gasCostUSD;

    if (estimatedProfit < MIN_PROFIT_USD) {
      log.warn(`  Skipping — profit $${estimatedProfit.toFixed(2)} below threshold $${MIN_PROFIT_USD}`);
      return;
    }

    // ── Step 3: Check gas price ───────────────────────────────
    const feeData = await httpProvider.getFeeData();
    const gasPriceGwei = Number(ethers.formatUnits(feeData.gasPrice || 0n, "gwei"));
    if (gasPriceGwei > MAX_GAS_GWEI) {
      log.warn(`  Gas too high: ${gasPriceGwei.toFixed(2)} gwei > max ${MAX_GAS_GWEI} gwei`);
      return;
    }

    // ── Step 4: Fire the transaction ──────────────────────────
    log.money(`  🚀 FIRING liquidation for ${user}...`);
    liquidating.add(user);

    const tx = await botContract.execute(
      collateralAsset,
      debtAsset,
      user,
      debtAmount,
      chainConfig.poolFees.default,
      {
        gasLimit: 800000,
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      }
    );

    log.info(`  TX sent: ${tx.hash}`);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      liquidationCount++;
      totalProfit += estimatedProfit;
      log.success(`  ✅ LIQUIDATION SUCCESS! TX: ${tx.hash}`);
      log.success(`  Estimated profit: $${estimatedProfit.toFixed(2)} | Total earned: $${totalProfit.toFixed(2)}`);

      // Send Telegram notification if configured
      await notify(`✅ Liquidation #${liquidationCount} successful!\nUser: ${user}\nProfit: ~$${estimatedProfit.toFixed(2)}\nTX: ${tx.hash}`);
    } else {
      log.error(`  ❌ Transaction reverted: ${tx.hash}`);
    }

  } catch (err) {
    log.error(`  Liquidation failed for ${user}: ${err.message}`);
  } finally {
    liquidating.delete(user);
    // Re-check this user after a delay
    setTimeout(() => addToWatchlist(user), 5000);
  }
}

// ── Find the best debt/collateral token pair to liquidate ────
async function findBestLiquidationPair(user) {
  try {
    const reserves = await aavePool.getReservesList();

    let bestDebtAsset = null;
    let bestCollateral = null;
    let bestDebtAmount = 0n;
    let bestDebtAmountNum = 0;

    for (const reserve of reserves) {
      try {
        const reserveData = await aavePool.getReserveData(reserve);
        const debtToken = reserveData.data.variableDebtTokenAddress;

        if (!debtToken || debtToken === ethers.ZeroAddress) continue;

        const debtContract = new ethers.Contract(debtToken, ERC20_ABI, httpProvider);
        const debtBal = await debtContract.balanceOf(user);

        if (debtBal === 0n) continue;

        const decimals = await debtContract.decimals().catch(() => 18);
        const debtNum = Number(ethers.formatUnits(debtBal, decimals));

        // Track the largest debt position (most profitable to liquidate)
        if (debtNum > bestDebtAmountNum) {
          bestDebtAmountNum = debtNum;
          bestDebtAsset = reserve;
          // Cover 50% (Aave's max per liquidation call)
          bestDebtAmount = debtBal / 2n;
        }
      } catch { }
    }

    // Find the best collateral to receive (highest balance)
    if (bestDebtAsset) {
      let bestCollateralBal = 0n;

      for (const reserve of reserves) {
        if (reserve === bestDebtAsset) continue;
        try {
          const rData = await aavePool.getReserveData(reserve);
          const aToken = rData.data.aTokenAddress;
          if (!aToken || aToken === ethers.ZeroAddress) continue;

          const aContract = new ethers.Contract(aToken, ERC20_ABI, httpProvider);
          const aBal = await aContract.balanceOf(user);

          if (aBal > bestCollateralBal) {
            bestCollateralBal = aBal;
            bestCollateral = reserve;
          }
        } catch { }
      }
    }

    return {
      debtAsset: bestDebtAsset,
      collateralAsset: bestCollateral,
      debtAmount: bestDebtAmount
    };

  } catch (err) {
    log.error("findBestLiquidationPair error:", err.message);
    return {};
  }
}

// ── Estimate gas cost in USD ─────────────────────────────────
async function estimateGasCostUSD() {
  try {
    const feeData = await httpProvider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("1", "gwei");
    const gasLimit = 800000n; // conservative estimate for full liquidation tx
    const gasCostETH = Number(ethers.formatEther(gasPrice * gasLimit));
    return gasCostETH * ethPriceUSD;
  } catch {
    return 2; // fallback $2 if fee data unavailable
  }
}

// ── Format base units (8 decimals in Aave's price oracle) ────
function formatBase(val) {
  return (Number(val) / 1e8).toFixed(2);
}

// ── Telegram Notification ────────────────────────────────────
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

// ── Load historical borrowers (bootstrap watchlist) ──────────
// Scans last N blocks for Borrow events to seed the watchlist
async function loadHistoricalBorrowers(blocksBack = 50000) {
  log.info(`Loading historical borrowers from last ${blocksBack} blocks...`);
  try {
    const currentBlock = await httpProvider.getBlockNumber();
    const fromBlock = currentBlock - blocksBack;
    const borrowTopic = ethers.id("Borrow(address,address,address,uint256,uint8,uint256,uint16)");

    // Fetch in chunks to avoid RPC limits
    const chunkSize = 10;
    let totalFound = 0;

    for (let from = fromBlock; from < currentBlock; from += chunkSize) {
      const to = Math.min(from + chunkSize - 1, currentBlock);
      try {
        const logs = await httpProvider.getLogs({
          address: chainConfig.aavePool,
          topics: [borrowTopic],
          fromBlock: from,
          toBlock: to
        });

        for (const l of logs) {
          try {
            // Aave V3: onBehalfOf is topics[2], decode properly
            if (l.topics[2]) {
              const user = "0x" + l.topics[2].slice(26).toLowerCase();
              if (user !== "0x" + "0".repeat(40)) {
                addToWatchlist(user);
                totalFound++;
              }
            }
          } catch { }
        }
      } catch { }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 100));
    }

    log.info(`Seeded watchlist with ${totalFound} historical borrowers`);
    log.info(`Active positions after filtering: ${watchedUsers.size}`);

  } catch (err) {
    log.error("Could not load historical borrowers:", err.message);
  }
}

// ── Main Loop ────────────────────────────────────────────────
async function main() {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║      AAVE V3 LIQUIDATION BOT — ACTIVE        ║");
  console.log(`║      Chain: ${chainConfig.name.padEnd(33)}║`);
  console.log(`║      Contract: ${CONTRACT_ADDR.slice(0, 20)}...   ║`);
  console.log("╚══════════════════════════════════════════════╝");
  console.log();

  // Verify wallet connection
  const balance = await httpProvider.getBalance(wallet.address);
  log.info(`Wallet: ${wallet.address}`);
  log.info(`ETH Balance: ${ethers.formatEther(balance)} ETH`);
  log.info(`Min profit threshold: $${MIN_PROFIT_USD}`);
  log.info(`Max gas: ${MAX_GAS_GWEI} gwei`);

  if (parseFloat(ethers.formatEther(balance)) < 0.001) {
    log.warn("⚠️  Very low ETH balance. Top up your wallet to pay for gas.");
  }

  // Verify contract ownership
  try {
    const contractOwner = await botContract.owner();
    if (contractOwner.toLowerCase() !== wallet.address.toLowerCase()) {
      log.error("Your wallet is NOT the owner of the contract. Check PRIVATE_KEY and CONTRACT_ADDRESS.");
      process.exit(1);
    }
    log.success("Contract ownership verified ✓");
  } catch (err) {
    log.error("Could not connect to contract:", err.message);
    log.error("Make sure CONTRACT_ADDRESS is correct and the contract is deployed.");
    process.exit(1);
  }

  // ── Immediate Telegram startup ping ──
  const ethBal = ethers.formatEther(balance);
  await notify(
    `🟢 Liquidation Bot Started\n` +
    `⛓ Chain: ${chainConfig.name}\n` +
    `📋 Contract: ${CONTRACT_ADDR.slice(0, 10)}...\n` +
    `🔋 ETH: ${parseFloat(ethBal).toFixed(4)}\n` +
    `💵 Min profit: $${MIN_PROFIT_USD}\n` +
    `⏳ Loading positions...`
  );

  // Start fresh ETH price updates
  await refreshEthPrice();
  setInterval(refreshEthPrice, 60_000); // update every minute

  // Load saved watchlist FIRST before scanning history
  loadWatchlist();

  // Bootstrap watchlist from historical events
  await loadHistoricalBorrowers(5000);

  // Start real-time event listening
  await startEventListening();

  // Scan loop — check all positions every 30 seconds
  log.info("Starting position scan loop (every 30s)...");
  setInterval(scanPositions, 30_000);
  await scanPositions(); // immediate first scan

  log.success(`Bot is live on ${chainConfig.name}. Watching ${watchedUsers.size} positions.`);

  // ── Telegram ready notification ──
  await notify(
    `✅ Liquidation Bot Ready\n` +
    `👁 Watching: ${watchedUsers.size} positions\n` +
    `🔄 Scanning every 30s`
  );

  // ── Hourly Telegram heartbeat + 10-min update checks ──
  let heartbeatTick = 0;
  setInterval(async () => {
    heartbeatTick++;

    // Every 20 ticks × 30s = 10 minutes — check for updates
    if (heartbeatTick % 20 === 0) {
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

    // 120 ticks × 30s = 1 hour — Telegram heartbeat
    if (heartbeatTick % 120 === 0) {
      const currentBal = await httpProvider.getBalance(wallet.address);
      await notify(
        `💓 Liquidation Bot Alive\n` +
        `⏱ Uptime: ${Math.floor(heartbeatTick / 120)}h\n` +
        `👁 Watching: ${watchedUsers.size} positions\n` +
        `💰 Earned: $${totalProfit.toFixed(2)}\n` +
        `🔋 ETH: ${parseFloat(ethers.formatEther(currentBal)).toFixed(4)}`
      );
    }
  }, 30_000);
}

// ── Graceful Shutdown ────────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n");
  log.info("Shutting down...");
  log.info(`Session summary: ${liquidationCount} liquidations | ~$${totalProfit.toFixed(2)} profit`);
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  log.error("Unhandled rejection:", err?.message || err);
});

// ── Start ────────────────────────────────────────────────────
main().catch(err => {
  log.error("Fatal error:", err.message);
  process.exit(1);
});
