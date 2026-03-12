const { ethers } = require("ethers");
const { ERC20_ABI } = require("../config");
const { getLogsChunked } = require("../utils");

const COMPTROLLER_ABI = [
    "function getAccountLiquidity(address account) external view returns (uint, uint, uint)",
    "function getAllMarkets() external view returns (address[])"
];

const MTOKEN_ABI = [
    "function borrowBalanceStored(address account) external view returns (uint)",
    "function balanceOf(address account) external view returns (uint)",
    "function underlying() external view returns (address)",
    "function decimals() external view returns (uint8)"
];

class MoonwellAdapter {
    constructor(provider, config) {
        this.provider = provider;
        this.config = config;
        this.contract = new ethers.Contract(config.comptroller, COMPTROLLER_ABI, provider);
        this.type = config.type;
        this.name = config.name;
    }

    async getWatchlistSeed(blocksBack = 1000) {
        // Moonwell stores users in Comptroller or we scan mToken Borrows
        const users = new Set();
        const mUSDC = this.config.mTokens.USDC;
        const borrowTopic = ethers.id("Borrow(address,uint256,uint256,uint256)");
        const currentBlock = await this.provider.getBlockNumber();
        const fromBlock = currentBlock - blocksBack;

        const logs = await getLogsChunked(this.provider, {
            address: mUSDC,
            topics: [borrowTopic],
            fromBlock,
            toBlock: "latest"
        }, 10);
        // In a real run, we'd use blocksBack
        return Array.from(users);
    }

    async getUserData(user) {
        const [error, liquidity, shortfall] = await this.contract.getAccountLiquidity(user);
        // shortfall > 0 means liquidatable
        const hf = shortfall > 0n ? 0.95 : 1.05;
        return {
            healthFactor: hf,
            totalDebt: shortfall,
            totalCollateral: liquidity
        };
    }

    async identifyLiquidationPair(user) {
        // find mToken with highest borrow
        const markets = await this.contract.getAllMarkets();
        let bestDebtMTokens = null;
        let maxDebt = 0n;

        for (const mToken of markets) {
            const mContract = new ethers.Contract(mToken, MTOKEN_ABI, this.provider);
            const borrow = await mContract.borrowBalanceStored(user);
            if (borrow > maxDebt) {
                maxDebt = borrow;
                bestDebtMTokens = mToken;
            }
        }

        // find mToken with highest collateral
        let bestCollateralMToken = null;
        let maxCollat = 0n;
        for (const mToken of markets) {
            const mContract = new ethers.Contract(mToken, MTOKEN_ABI, this.provider);
            const bal = await mContract.balanceOf(user);
            if (bal > maxCollat) {
                maxCollat = bal;
                bestCollateralMToken = mToken;
            }
        }

        return {
            debtAsset: (new ethers.Contract(bestDebtMTokens, MTOKEN_ABI, this.provider)).underlying(), // Actually the underlying
            collateralAsset: bestCollateralMToken, // Contract needs the cToken for liquidateBorrow
            debtAmount: maxDebt / 2n,
            protocolAddress: bestDebtMTokens // In Moonwell, we call liquidateBorrow on the MToken of the debt
        };
    }
}

module.exports = MoonwellAdapter;
