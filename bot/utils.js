const { ethers } = require("ethers");

/**
 * Fetches logs in chunks with a "Hot-Swap" fallback system.
 * If an RPC fails (503, 429, Timeout), it automatically tries the next one in the list.
 */
async function getLogsChunked(rpcUrls, filter, chunkSize = 1000) {
    const logs = [];
    let currentRpcIndex = 0;

    // Initial provider setup
    let provider = new ethers.JsonRpcProvider(rpcUrls[currentRpcIndex], undefined, { staticNetwork: true });

    const currentBlock = await provider.getBlockNumber();
    const fromBlock = typeof filter.fromBlock === "number" ? filter.fromBlock : currentBlock - 1000;
    const toBlock = typeof filter.toBlock === "number" ? filter.toBlock : currentBlock;

    for (let current = fromBlock; current < toBlock; current += chunkSize) {
        const end = Math.min(current + chunkSize - 1, toBlock);
        let success = false;
        let attemptsPerRpc = 0;

        while (!success && currentRpcIndex < rpcUrls.length) {
            try {
                const chunk = await provider.getLogs({
                    ...filter,
                    fromBlock: current,
                    toBlock: end
                });
                logs.push(...chunk);
                success = true;
            } catch (e) {
                const msg = e.message || "";
                const isRetryable = msg.includes("503") || msg.includes("429") || msg.includes("Timeout") || msg.includes("SERVER_ERROR");

                if (isRetryable && attemptsPerRpc < 2) {
                    attemptsPerRpc++;
                    const delay = attemptsPerRpc * 1000;
                    console.warn(`[Utils] Chunk failed [${current}-${end}] on ${rpcUrls[currentRpcIndex].split('//')[1].split('/')[0]}. Retrying in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay));
                } else {
                    // Switch RPC
                    currentRpcIndex++;
                    if (currentRpcIndex < rpcUrls.length) {
                        console.warn(`[Utils] Switching to next RPC: ${rpcUrls[currentRpcIndex].split('//')[1].split('/')[0]} due to persistent failure.`);
                        provider = new ethers.JsonRpcProvider(rpcUrls[currentRpcIndex], undefined, { staticNetwork: true });
                        attemptsPerRpc = 0; // Reset attempts for the new RPC
                    } else {
                        console.error(`[Utils] CRITICAL: All ${rpcUrls.length} RPCs failed for chunk [${current}-${end}]`);
                        break;
                    }
                }
            }
        }
    }

    return {
        logs,
        lastWorkingRpc: rpcUrls[currentRpcIndex]
    };
}

module.exports = { getLogsChunked };
