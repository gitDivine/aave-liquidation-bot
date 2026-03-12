const { ethers } = require("ethers");

/**
 * Fetches logs in small chunks to avoid RPC limits (e.g. Alchemy's 10-block limit on Base Free Tier)
 */
async function getLogsChunked(provider, filter, chunkSize = 1000) {
    const logs = [];
    const currentBlock = await provider.getBlockNumber();
    const fromBlock = typeof filter.fromBlock === "number" ? filter.fromBlock : currentBlock - 1000;
    const toBlock = typeof filter.toBlock === "number" ? filter.toBlock : currentBlock;

    for (let current = fromBlock; current < toBlock; current += chunkSize) {
        const end = Math.min(current + chunkSize - 1, toBlock);
        let attempts = 0;
        let success = false;

        while (attempts < 3 && !success) {
            try {
                const chunk = await provider.getLogs({
                    ...filter,
                    fromBlock: current,
                    toBlock: end
                });
                logs.push(...chunk);
                success = true;
            } catch (e) {
                attempts++;
                const isRetryable = e.message.includes("503") || e.message.includes("429") || e.message.includes("Timeout");
                if (isRetryable && attempts < 3) {
                    const delay = attempts * 2000;
                    console.warn(`[Utils] Log chunk failed [${current}-${end}]. Retrying in ${delay}ms... (Attempt ${attempts}/3)`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    console.error(`[Utils] Log chunk permanently failed [${current}-${end}]: ${e.message}`);
                    break;
                }
            }
        }
    }
    return logs;
}

module.exports = { getLogsChunked };
