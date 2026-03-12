const { ethers } = require("ethers");
const { ERC20_ABI } = require("../config");
const { getLogsChunked } = require("../utils");

const COMET_ABI = [
    "function absorb(address[] calldata accounts) external",
    "function buyCollateral(address asset, uint minAmount, uint baseAmount, address recipient) external",
    "function getAccountQuote(address account) external view returns (uint256, uint256, uint256)",
    "function getAssetInfo(uint8 i) external view returns (tuple(uint8 index, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))",
    "function numAssets() external view returns (uint8)",
    "function baseToken() external view returns (address)",
    "function isLiquidatable(address account) external view returns (bool)",
    "event AbsorbDebt(address indexed absorber, address indexed borrower, uint256 basePaidOut, uint256 usdValue)"
];

class CompoundV3Adapter {
    constructor(provider, config) {
        this.provider = provider;
        this.config = config;
        this.contract = new ethers.Contract(config.comet, COMET_ABI, provider);
        this.type = config.type;
        this.name = config.name;
    }

    async getWatchlistSeed(rpcUrls, blocksBack = 1000) {
        const fromBlock = (await this.provider.getBlockNumber()) - blocksBack;
        const supplyTopic = ethers.id("Supply(address,address,uint256)");
        const users = new Set();

        const { logs, lastWorkingRpc } = await getLogsChunked(rpcUrls, {
            address: this.config.comet,
            topics: [supplyTopic],
            fromBlock,
            toBlock: "latest"
        });

        for (const l of logs) {
            if (l.topics[2]) users.add("0x" + l.topics[2].slice(26).toLowerCase());
        }
        return {
            users: Array.from(users),
            lastWorkingRpc
        };
    }

    async getUserData(user) {
        const isLiquidatable = await this.contract.isLiquidatable(user);
        // Compound V3 doesn't expose a simple Health Factor to external view easily in one call
        // but we can use isLiquidatable as a proxy. 0.99 if liquidatable, 1.01 if not.
        return {
            healthFactor: isLiquidatable ? 0.95 : 1.05,
            totalDebt: 1n, // Placeholder since Comet data is complex
            totalCollateral: 1n,
        };
    }

    async identifyLiquidationPair(user) {
        // In Compound V3, you liquidate the account (absorb), then buy collateral.
        // We need to find which collateral asset has the most value.
        const numAssets = await this.contract.numAssets();
        const baseToken = await this.contract.baseToken();
        let bestCollateral = null;
        let maxBal = 0n;

        for (let i = 0; i < numAssets; i++) {
            const assetInfo = await this.contract.getAssetInfo(i);
            const assetContract = new ethers.Contract(assetInfo.asset, ERC20_ABI, this.provider);
            // This is a bit slow - in production we'd use a UI Data Provider
            const bal = await assetContract.balanceOf(user);
            if (bal > maxBal) {
                maxBal = bal;
                bestCollateral = assetInfo.asset;
            }
        }

        return {
            debtAsset: baseToken,
            collateralAsset: bestCollateral,
            debtAmount: 0n, // Contract will absorb what it can
            protocolAddress: this.config.comet
        };
    }
}

module.exports = CompoundV3Adapter;
