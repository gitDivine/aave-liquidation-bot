const { ethers } = require("ethers");

/**
 * Fetches logs in small chunks to avoid RPC limits (e.g. Alchemy's 10-block limit on Base Free Tier)
 */
async function getLogsChunked(provider, filter, chunkSize = 10) {
    const logs = [];
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = filter.fromBlock === "latest" ? currentBlock : filter.fromBlock;
    const toBlock = filter.toBlock === "latest" ? currentBlock : filter.toBlock;

    for (let current = fromBlock; current < toBlock; current += chunkSize) {
        const end = Math.min(current + chunkSize - 1, toBlock);
        try {
            const chunk = await provider.getLogs({
                ...filter,
                fromBlock: current,
                toBlock: end
            });
            logs.push(...chunk);
        } catch (e) {
            console.warn(`[Utils] Log chunk failed [${current}-${end}]: ${e.message}`);
        }
    }
    return logs;
}

module.exports = { getLogsChunked };
