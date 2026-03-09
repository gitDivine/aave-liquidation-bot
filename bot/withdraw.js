// ============================================================
//  WITHDRAW PROFITS
//  Run this to pull profits from your contract to your wallet
//  Usage: node bot/withdraw.js <token_address>
//  Example: node bot/withdraw.js 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
// ============================================================

require("dotenv").config();
const { ethers } = require("ethers");
const { BOT_CONTRACT_ABI, ERC20_ABI, CHAINS } = require("./config");

async function withdraw() {
  const tokenAddress = process.argv[2];

  const chain       = process.env.CHAIN || "base";
  const chainConfig = CHAINS[chain];
  const provider    = new ethers.JsonRpcProvider(process.env.ALCHEMY_HTTP_URL);
  const wallet      = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const contract    = new ethers.Contract(process.env.CONTRACT_ADDRESS, BOT_CONTRACT_ABI, wallet);

  if (!tokenAddress) {
    console.log("\n📋  Known tokens on", chainConfig.name + ":");
    for (const [symbol, info] of Object.entries(chainConfig.tokens)) {
      try {
        const bal = await contract.getBalance(info.address);
        const formatted = ethers.formatUnits(bal, info.decimals);
        if (parseFloat(formatted) > 0) {
          console.log(`  ${symbol}: ${formatted} (${info.address})`);
        }
      } catch {}
    }
    console.log("\n  Usage: node bot/withdraw.js <token_address>\n");
    return;
  }

  try {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [symbol, decimals, balance] = await Promise.all([
      tokenContract.symbol(),
      tokenContract.decimals(),
      contract.getBalance(tokenAddress)
    ]);

    if (balance === 0n) {
      console.log(`\n  No ${symbol} balance in contract.\n`);
      return;
    }

    const formatted = ethers.formatUnits(balance, decimals);
    console.log(`\n  Withdrawing ${formatted} ${symbol} to ${wallet.address}...`);

    const tx      = await contract.withdraw(tokenAddress);
    const receipt = await tx.wait();

    if (receipt.status === 1) {
      console.log(`  ✅  Withdrawn! TX: ${tx.hash}\n`);
    } else {
      console.log(`  ❌  Transaction failed: ${tx.hash}\n`);
    }
  } catch (err) {
    console.error("  Error:", err.message);
  }
}

withdraw();
