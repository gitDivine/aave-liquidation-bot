const { ethers } = require("ethers");
const { AAVE_POOL_ABI, ERC20_ABI } = require("../config");
const { getLogsChunked } = require("../utils");

class AaveV3Adapter {
    constructor(provider, config) {
        this.provider = provider;
        this.config = config;
        this.contract = new ethers.Contract(config.poolAddress, AAVE_POOL_ABI, provider);
        this.type = config.type;
        this.name = config.name;
    }

    async getWatchlistSeed(blocksBack = 1000) {
        const currentBlock = await this.provider.getBlockNumber();
        const fromBlock = currentBlock - blocksBack;
        const borrowTopic = ethers.id("Borrow(address,address,address,uint256,uint8,uint256,uint16)");
        const users = new Set();

        const logs = await getLogsChunked(this.provider, {
            address: this.config.poolAddress,
            topics: [borrowTopic],
            fromBlock,
            toBlock: "latest"
        });

        for (const l of logs) {
            if (l.topics[2]) {
                users.add("0x" + l.topics[2].slice(26).toLowerCase());
            }
        }
        return Array.from(users);
    }

    async getUserData(user) {
        const data = await this.contract.getUserAccountData(user);
        return {
            healthFactor: Number(ethers.formatUnits(data.healthFactor, 18)),
            totalDebt: data.totalDebtBase,
            totalCollateral: data.totalCollateralBase,
        };
    }

    async identifyLiquidationPair(user) {
        const reserves = await this.contract.getReservesList();
        let bestDebtAsset = null;
        let bestCollateral = null;
        let bestDebtAmount = 0n;
        let maxDebtUsd = 0;

        for (const reserve of reserves) {
            const reserveData = await this.contract.getReserveData(reserve);
            const debtToken = reserveData.data.variableDebtTokenAddress;
            if (!debtToken || debtToken === ethers.ZeroAddress) continue;

            const debtContract = new ethers.Contract(debtToken, ERC20_ABI, this.provider);
            const debtBal = await debtContract.balanceOf(user);
            if (debtBal === 0n) continue;

            const dec = await debtContract.decimals();
            const debtUsd = Number(ethers.formatUnits(debtBal, dec)); // Approximate USD
            if (debtUsd > maxDebtUsd) {
                maxDebtUsd = debtUsd;
                bestDebtAsset = reserve;
                bestDebtAmount = debtBal / 2n;
            }
        }

        if (bestDebtAsset) {
            let maxCollateralUsd = 0;
            for (const reserve of reserves) {
                const rData = await this.contract.getReserveData(reserve);
                const aToken = rData.data.aTokenAddress;
                if (!aToken || aToken === ethers.ZeroAddress) continue;
                const aContract = new ethers.Contract(aToken, ERC20_ABI, this.provider);
                const aBal = await aContract.balanceOf(user);
                const dec = await aContract.decimals();
                const collatUsd = Number(ethers.formatUnits(aBal, dec));
                if (collatUsd > maxCollateralUsd) {
                    maxCollateralUsd = collatUsd;
                    bestCollateral = reserve;
                }
            }
        }

        return {
            debtAsset: bestDebtAsset,
            collateralAsset: bestCollateral,
            debtAmount: bestDebtAmount,
            protocolAddress: this.config.poolAddress
        };
    }
}

module.exports = AaveV3Adapter;
