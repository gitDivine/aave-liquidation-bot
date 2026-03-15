// ============================================================
//  MULTI-PROTOCOL LIQUIDATION BOT — MAIN SCRIPT
//  Supports: Aave V3, Compound V3, Moonwell
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const { execSync } = require("child_process");
const { CONTRACT_ADDRESS, MULTICALL3_ADDRESS, CHAINS, PROTOCOLS, BOT_CONTRACT_ABI, MULTICALL3_ABI } = require("./config");

// Adapters
const AaveV3Adapter = require("./protocols/AaveV3Adapter");
const CompoundV3Adapter = require("./protocols/CompoundV3Adapter");
const MoonwellAdapter = require("./protocols/MoonwellAdapter");

function autoUpdate() {
  try {
    // Safety: Reset files modified by npm install before pulling
    try { execSync("git checkout package.json package-lock.json", { timeout: 5000 }); } catch {}
    
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
const FALLBACKS_BY_CHAIN = {
  base: ["https://mainnet.base.org", "https://base.publicnode.com", "https://1rpc.io/base"],
  arbitrum: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.public-rpc.com", "https://1rpc.io/arbitrum"]
};
const CHAIN = process.env.CHAIN || "base";
const PUBLIC_RPCS = FALLBACKS_BY_CHAIN[CHAIN] || FALLBACKS_BY_CHAIN.base;

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const HTTP_URL = process.env.ALCHEMY_HTTP_URL || (CHAIN === "base" ? "https://mainnet.base.org" : "https://arb1.arbitrum.io/rpc");
const WS_URL = process.env.ALCHEMY_WS_URL || (CHAIN === "base" ? "wss://mainnet.base.org/ws" : "wss://arb1.arbitrum.io/feed");
const CONTRACT_ADDR = CONTRACT_ADDRESS;
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
  DANGEROUS: 'dangerous', // HF < 1.3 — every 60s
  SAFE: 'safe'            // HF >= 1.3 — every 5 mins
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
  adapters.push(new AaveV3Adapter(httpProvider, PROTOCOLS.aaveV3));
  adapters.push(new CompoundV3Adapter(httpProvider, PROTOCOLS.compoundV3));
  adapters.push(new MoonwellAdapter(httpProvider, PROTOCOLS.moonwell));
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
          // New users start in SAFE bucket until their first scan
          watchedUsers.set(key, { protocol: adapter.name, address: user, lastChecked: 0, bucket: BUCKETS.SAFE });
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

  // 2. Start Tiered Scan Cycles
  setInterval(() => scanBucket(BUCKETS.CRITICAL), 30_000);  // Death Row: 30s
  setInterval(() => scanBucket(BUCKETS.DANGEROUS), 60_000); // Watchlist: 60s
  setInterval(() => scanBucket(BUCKETS.SAFE), 300_000);      // Safe Zone: 5m
  
  scanBucket(BUCKETS.CRITICAL);
  scanBucket(BUCKETS.DANGEROUS);
  scanBucket(BUCKETS.SAFE);

  // 3. High-Frequency discovery (Active Hunting Every 10m)
  setInterval(() => seedWatchlist(10000), 600_000);

  // 4. 10-minute auto-update checks
  setInterval(async () => {
    try {
      // Safety: Reset files modified by npm install before pulling
      try { execSync("git checkout package.json package-lock.json", { timeout: 5000 }); } catch {}
      
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
