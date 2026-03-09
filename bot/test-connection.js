// ============================================================
//  CONNECTION TEST
//  Run this FIRST to verify everything is set up correctly
//  Usage: node bot/test-connection.js
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const { CHAINS, AAVE_POOL_ABI, BOT_CONTRACT_ABI } = require("./config");

async function test() {
  console.log("\n🔧  Running connection tests...\n");
  let passed = 0;
  let failed = 0;

  const check = (name, result, detail = "") => {
    if (result) {
      console.log(`  ✅  ${name}${detail ? " — " + detail : ""}`);
      passed++;
    } else {
      console.log(`  ❌  ${name}${detail ? " — " + detail : ""}`);
      failed++;
    }
  };

  // ── Test 1: .env values present ───────────────────────────
  check("PRIVATE_KEY set",       !!process.env.PRIVATE_KEY,      process.env.PRIVATE_KEY ? "found" : "missing");
  check("ALCHEMY_WS_URL set",    !!process.env.ALCHEMY_WS_URL,   process.env.ALCHEMY_WS_URL ? "found" : "missing");
  check("ALCHEMY_HTTP_URL set",  !!process.env.ALCHEMY_HTTP_URL, process.env.ALCHEMY_HTTP_URL ? "found" : "missing");
  check("CONTRACT_ADDRESS set",  !!process.env.CONTRACT_ADDRESS, process.env.CONTRACT_ADDRESS ? "found" : "missing");

  const chain = process.env.CHAIN || "base";
  const chainConfig = CHAINS[chain];
  check("Chain valid", !!chainConfig, chain);

  if (!chainConfig) {
    console.log("\n❌  Cannot continue — invalid chain config\n");
    return;
  }

  // ── Test 2: RPC connection ─────────────────────────────────
  let provider;
  try {
    provider = new ethers.JsonRpcProvider(process.env.ALCHEMY_HTTP_URL);
    const blockNumber = await provider.getBlockNumber();
    check("RPC connected", true, `block #${blockNumber}`);
  } catch (err) {
    check("RPC connected", false, err.message);
    console.log("\n❌  Cannot continue — RPC connection failed\n");
    return;
  }

  // ── Test 3: Wallet ─────────────────────────────────────────
  let wallet;
  try {
    wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const balance = await provider.getBalance(wallet.address);
    const ethBal  = parseFloat(ethers.formatEther(balance));
    check("Wallet loaded", true, `${wallet.address.slice(0,10)}...`);
    check("ETH balance OK", ethBal > 0.001, `${ethBal.toFixed(6)} ETH ${ethBal < 0.001 ? "⚠️  LOW" : "✓"}`);
  } catch (err) {
    check("Wallet loaded", false, err.message);
    console.log("\n❌  Cannot continue — Wallet error\n");
    return;
  }

  // ── Test 4: Aave Pool reachable ────────────────────────────
  try {
    const aavePool = new ethers.Contract(chainConfig.aavePool, AAVE_POOL_ABI, provider);
    const reserves = await aavePool.getReservesList();
    check("Aave Pool connected", true, `${reserves.length} reserves found`);
  } catch (err) {
    check("Aave Pool connected", false, err.message);
  }

  // ── Test 5: Your deployed contract ────────────────────────
  if (process.env.CONTRACT_ADDRESS) {
    try {
      const botContract = new ethers.Contract(process.env.CONTRACT_ADDRESS, BOT_CONTRACT_ABI, wallet);
      const owner = await botContract.owner();
      const isOwner = owner.toLowerCase() === wallet.address.toLowerCase();
      check("Contract reachable", true, `owner: ${owner.slice(0,10)}...`);
      check("You are the owner", isOwner, isOwner ? "confirmed" : `owner is ${owner}, not your wallet`);
    } catch (err) {
      check("Contract reachable", false, "Contract not found — deploy it first");
    }
  }

  // ── Test 6: WebSocket ──────────────────────────────────────
  try {
    await new Promise((resolve, reject) => {
      const wsProvider = new ethers.WebSocketProvider(process.env.ALCHEMY_WS_URL);
      wsProvider.websocket.on("open", () => {
        check("WebSocket connected", true, "real-time monitoring ready");
        wsProvider.destroy();
        resolve();
      });
      wsProvider.websocket.on("error", (e) => {
        check("WebSocket connected", false, e.message);
        reject(e);
      });
      setTimeout(() => reject(new Error("timeout")), 10000);
    });
  } catch (err) {
    check("WebSocket connected", false, err.message);
  }

  // ── Summary ────────────────────────────────────────────────
  console.log(`\n─────────────────────────────────────────`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log(`  🚀  All systems go! Run: npm start`);
  } else {
    console.log(`  ⚠️   Fix the failed checks before running the bot`);
  }
  console.log(`─────────────────────────────────────────\n`);
}

test().catch(console.error);
