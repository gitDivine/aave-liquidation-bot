// ============================================================
//  MULTI-PROTOCOL LIQUIDATION BOT — MAIN SCRIPT
//  Supports: Aave V3, Compound V3, Moonwell
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const { execSync } = require("child_process");
const { CONTRACT_ADDRESS: DEFAULT_CONTRACT_ADDRESS, MULTICALL3_ADDRESS, CHAINS, PROTOCOLS, BOT_CONTRACT_ABI, MULTICALL3_ABI } = require("./config");

// Adapters
const AaveV3Adapter = require("./protocols/AaveV3Adapter");
const CompoundV3Adapter = require("./protocols/CompoundV3Adapter");
const MoonwellAdapter = require("./protocols/MoonwellAdapter");

function autoUpdate() {
  try {
    const branch = 'master';
    execSync(`git fetch origin ${branch}`, { stdio: 'ignore', timeout: 15000 });
    
    const local = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const remote = execSync(`git rev-parse origin/${branch}`, { encoding: 'utf8' }).trim();
    
    if (local !== remote) {
      console.log(`[Update] New version detected (${remote.slice(0, 7)}). Applying clean update...`);
      
      // Force clean reset to remote state
      execSync(`git reset --hard origin/${branch}`, { stdio: 'inherit' });
      
      // Re-install dependencies
      console.log('[Update] Re-installing dependencies...');
      execSync('npm install --omit=dev', { encoding: 'utf8', timeout: 60000 });
      
      console.log('[Update] Update applied. Restarting bot...');
      process.exit(0);
    }
  } catch (err) {
    console.warn('[Update] Auto-update skipped:', err.message);
  }
}
autoUpdate();

// ── Load & Validate Config ───────────────────────────────────
const FALLBACKS_BY_CHAIN = {
  base: ["https://mainnet.base.org", "https://base.publicnode.com", "https://1rpc.io/base"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.public-rpc.com", "https://1rpc.io/arbitrum"]
};
const CHAIN = (process.env.CHAIN || "base").toLowerCase().trim();
const PUBLIC_RPCS = FALLBACKS_BY_CHAIN[CHAIN] || FALLBACKS_BY_CHAIN.base;

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const HTTP_URL = process.env.ALCHEMY_HTTP_URL || (CHAIN === "base" ? "https://mainnet.base.org" : "https://arb1.arbitrum.io/rpc");
const WS_URL = process.env.ALCHEMY_WS_URL || (CHAIN === "base" ? "wss://mainnet.base.org/ws" : "wss://arb1.arbitrum.io/feed");
const CONTRACT_ADDR = process.env.CONTRACT_ADDRESS || DEFAULT_CONTRACT_ADDRESS;
if (!CONTRACT_ADDR) {
  console.error("❌ CRITICAL: CONTRACT_ADDRESS not found in .env or config.");
  process.exit(1);
}
const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "2");
const MAX_GAS_GWEI = parseFloat(process.env.MAX_GAS_GWEI || "50");

let httpProvider;
let workingRpcUrl;

async function validateRpc() {
  const probe = async (url) => {
    try {
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      await Promise.race([
        p.getBlockNumber(), // More standard than getNetwork
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
      ]);
      return p;
    } catch (err) {
      return null;
    }
  };

  log.info(`Validating RPC infrastructure for ${CHAIN.toUpperCase()}...`);

  // 1. Try Primary (Alchemy/User Config)
  if (HTTP_URL && HTTP_URL !== workingRpcUrl) {
    const primary = await probe(HTTP_URL);
    if (primary) {
      httpProvider = primary;
      log.success(`Primary RPC connected: ${HTTP_URL.split('//')[1]?.split('/')[0]} ✓`);
      workingRpcUrl = HTTP_URL;
      return workingRpcUrl;
    }
  }

  // 2. Rotate through Public Fallbacks
  for (const rpc of PUBLIC_RPCS) {
    if (rpc === workingRpcUrl) continue; // Skip if it just failed
    const fb = await probe(rpc);
    if (fb) {
      httpProvider = fb;
      log.success(`Switching to public fallback: ${rpc.split('//')[1]?.split('/')[0]} ✓`);
      workingRpcUrl = rpc;
      return rpc;
    }
  }

  log.error("CRITICAL: All RPC providers failed. Retrying with first public node anyway...");
  httpProvider = new ethers.JsonRpcProvider(PUBLIC_RPCS[0], undefined, { staticNetwork: true });
  return PUBLIC_RPCS[0];
}

let wallet;
let botContract;
let multicallContract;

async function setupWallet() {
  workingRpcUrl = await validateRpc();
  wallet = new ethers.Wallet(PRIVATE_KEY, httpProvider);
  botContract = new ethers.Contract(CONTRACT_ADDR, BOT_CONTRACT_ABI, wallet);
  multicallContract = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, wallet);
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
const watchedUsers = new Map(); // address → { hf, debt, collateral, protocol, bucket, lastChecked }
const liquidating = new Set();
const adapters = [];
let totalProfit = 0;
let liquidationCount = 0;
let isScanning = { critical: false, dangerous: false, safe: false };

const BUCKETS = {
  CRITICAL: 'critical',   // HF < 1.1 — every 30s
  DANGEROUS: 'dangerous', // HF < 1.3 — every 2 mins
  SAFE: 'safe'            // HF >= 1.3 — every 10 mins
};

const log = {
  info: (...m) => console.log(`[${new Date().toISOString()}] ℹ️  `, ...m),
  success: (...m) => console.log(`[${new Date().toISOString()}] ✅  `, ...m),
  warn: (...m) => console.log(`[${new Date().toISOString()}] ⚠️  `, ...m),
  error: (...m) => console.error(`[${new Date().toISOString()}] ❌  `, ...m),
  money: (...m) => console.log(`[${new Date().toISOString()}] 💰  `, ...m),
};

// ── Initialize Adapters ──────────────────────────────────────
function initAdapters() {
  if (PROTOCOLS.aaveV3.poolAddress) {
    adapters.push(new AaveV3Adapter(httpProvider, PROTOCOLS.aaveV3));
  }
  if (PROTOCOLS.compoundV3.comet) {
    adapters.push(new CompoundV3Adapter(httpProvider, PROTOCOLS.compoundV3));
  }
  if (PROTOCOLS.moonwell.comptroller) {
    adapters.push(new MoonwellAdapter(httpProvider, PROTOCOLS.moonwell));
  }
}

// ── Main Loop ────────────────────────────────────────────────
async function scanBucket(bucket) {
  if (isScanning[bucket]) return;
  isScanning[bucket] = true;

  try {
    const usersInBucket = Array.from(watchedUsers.entries())
      .filter(([_, data]) => data.bucket === bucket);

    if (usersInBucket.length === 0) return;

    log.info(`[Loop: ${bucket.toUpperCase()}] Scanning ${usersInBucket.length} users...`);

    for (const adapter of adapters) {
      const protocolUsers = usersInBucket
        .filter(([_, data]) => data.protocol === adapter.name)
        .map(([key, data]) => ({ key, data }));

      if (protocolUsers.length === 0) continue;

      // Batch users into chunks of 50
      const CHUNK_SIZE = 50;
      for (let i = 0; i < protocolUsers.length; i += CHUNK_SIZE) {
        const chunk = protocolUsers.slice(i, i + CHUNK_SIZE);
        const calls = chunk.map(u => adapter.getHealthFactorCallData(u.data.address));

        try {
          const results = await multicallContract.tryAggregate.staticCall(false, calls);

          for (let j = 0; j < results.length; j++) {
            const { success, returnData } = results[j];
            const u = chunk[j];

            if (success && returnData !== "0x") {
              const updated = adapter.decodeHealthFactor(returnData);
              const oldBucket = u.data.bucket;
              const newBucket = updated.healthFactor < 1.1 ? BUCKETS.CRITICAL : (updated.healthFactor < 1.3 ? BUCKETS.DANGEROUS : BUCKETS.SAFE);

              // Update user state
              watchedUsers.set(u.key, { ...u.data, ...updated, bucket: newBucket, lastChecked: Date.now() });

              if (newBucket !== oldBucket) {
                log.info(`[Triage] User ${u.data.address} moved: ${oldBucket} → ${newBucket} (HF: ${updated.healthFactor.toFixed(3)})`);
              }

              if (updated.healthFactor < 1.0 && !liquidating.has(u.data.address)) {
                processLiquidation(u.data.address, adapter);
              }
            }
          }
        } catch (e) {
          const is429 = e.message.includes("429") || e.message.includes("limit exceeded");
          if (is429) {
            log.error(`RPC 429 detected in ${bucket} scan! Triggering failover...`);
            await setupWallet();
            return; // Exit this loop and retry on next interval
          }
          log.warn(`Batch scan failed for ${adapter.name} (${bucket}): ${e.message}`);
        }
      }
    }
  } finally {
    isScanning[bucket] = false;
  }
}

async function processLiquidation(user, adapter) {
  if (liquidating.has(user)) return;
  liquidating.add(user);
  log.money(`Target identified: ${user} on ${adapter.name}`);

  try {
    // Gas guard — skip if gas is too expensive
    const feeData = await httpProvider.getFeeData();
    const gasGwei = Number(feeData.gasPrice || 0n) / 1e9;
    if (gasGwei > MAX_GAS_GWEI) {
      log.warn(`⛽ Gas too high: ${gasGwei.toFixed(1)} gwei > ${MAX_GAS_GWEI} max. Skipping ${user}`);
      return;
    }

    const params = await adapter.identifyLiquidationPair(user);
    if (!params.debtAsset || !params.collateralAsset) {
      log.warn(`Could not find liquidation pair for ${user}`);
      return;
    }

    // Try pool fees from config: default first, then fallback
    const chainConfig = CHAINS[CHAIN] || CHAINS.base;
    const feesToTry = [chainConfig.poolFees.default, chainConfig.poolFees.fallback];

    // STEP 1: Simulation (Sniper Mode) — try each fee tier
    let bestFee = null;
    for (const fee of feesToTry) {
      const success = await simulateLiquidation(params, adapter, user, fee);
      if (success) { bestFee = fee; break; }
    }

    if (bestFee === null) {
      log.warn(`❌ Simulation REVERTED at all fee tiers: ${user} (Stale or Front-run)`);
      return;
    }

    log.success(`🎯 Simulation SUCCESS (fee: ${bestFee}): Proceeding with liquidation for ${user}`);

    // STEP 2: Fire real transaction with the fee tier that passed simulation
    const tx = await botContract.execute(
      params.collateralAsset,
      params.debtAsset,
      user,
      params.debtAmount,
      bestFee,
      adapter.type,
      params.protocolAddress,
      { gasLimit: 1_200_000 }
    );

    log.info(`TX Sent: ${tx.hash}`);
    const receipt = await tx.wait();
    if (receipt.status === 1) {
      liquidationCount++;
      const gasCost = Number(receipt.gasUsed * (receipt.gasPrice || feeData.gasPrice)) / 1e18;
      log.success(`Liquidation successful! Protocol: ${adapter.name} | Gas: ${gasCost.toFixed(5)} ETH`);
      await notify(`✅ Liquidation on ${adapter.name} successful!\nTarget: ${user}\nFee tier: ${bestFee}\nGas: ${gasCost.toFixed(5)} ETH\nTX: ${tx.hash}`);
    }
  } catch (err) {
    log.error(`Liquidation execution failed: ${err.message}`);
  } finally {
    liquidating.delete(user);
  }
}

async function simulateLiquidation(params, adapter, user, poolFee) {
  try {
    // We use staticCall to simulate for $0 gas
    await botContract.execute.staticCall(
      params.collateralAsset,
      params.debtAsset,
      user,
      params.debtAmount,
      poolFee,
      adapter.type,
      params.protocolAddress
    );
    return true;
  } catch (e) {
    return false;
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
          // New users start in SAFE bucket until their first scan
          watchedUsers.set(key, { protocol: adapter.name, address: user, lastChecked: 0, bucket: BUCKETS.SAFE });
          newUsersCount++;
        }
      }
    } catch (err) {
      if (err.message.includes("429") || err.message.includes("limit exceeded")) {
        log.error("RPC 429 detected during discovery! Triggering failover...");
        await setupWallet();
      } else {
        log.warn(`Discovery failed for ${adapter.name}: ${err.message}`);
      }
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

  // 2. Start Tiered Scan Cycles
  setInterval(() => scanBucket(BUCKETS.CRITICAL), 30_000);   // Death Row: 30s
  setInterval(() => scanBucket(BUCKETS.DANGEROUS), 120_000); // Watchlist: 2m
  setInterval(() => scanBucket(BUCKETS.SAFE), 600_000);      // Safe Zone: 10m
  
  scanBucket(BUCKETS.CRITICAL);
  scanBucket(BUCKETS.DANGEROUS);
  scanBucket(BUCKETS.SAFE);

  // 3. 30-minute discovery (Active Hunting Every 30m)
  setInterval(() => seedWatchlist(10000), 1_800_000);

  // 4. 10-minute auto-update checks
  setInterval(() => autoUpdate(), 600_000);
}

main().catch(e => log.error("Fatal:", e.message));
