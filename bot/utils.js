const { ethers } = require("ethers");

/**
 * Fetches logs in chunks with a "Hot-Swap" fallback system.
 * If an RPC fails (503, 429, Timeout), it automatically tries the next one in the list.
 */
async function getLogsChunked(rpcUrls, filter, chunkSize = 1000) {
    const logs = [];
    let currentRpcIndex = 0;

    // Create function to get provider with timeout
    const getSafeProvider = async (index) => {
        try {
            const p = new ethers.JsonRpcProvider(rpcUrls[index], undefined, { staticNetwork: true });
            // FORCE a network check with a timeout
            await Promise.race([
                p.getBlockNumber(),
                new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 5000))
            ]);
            return p;
        } catch (e) {
            return null;
        }
    };

    let provider = await getSafeProvider(currentRpcIndex);

    // If first one fails, find the first working one
    while (!provider && currentRpcIndex < rpcUrls.length - 1) {
        currentRpcIndex++;
        console.warn(`[Utils] Primary RPC in list failed immediately. Trying ${rpcUrls[currentRpcIndex].split('//')[1]?.split('/')[0]}...`);
        provider = await getSafeProvider(currentRpcIndex);
    }

    if (!provider) {
        console.error("[Utils] CRITICAL: No working RPCs found for seeding.");
        return { logs: [], lastWorkingRpc: rpcUrls[0] };
    }

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

                if (isRetryable && attemptsPerRpc < 1) { // Faster switch
                    attemptsPerRpc++;
                    console.warn(`[Utils] Chunk failed on ${rpcUrls[currentRpcIndex].split('//')[1]?.split('/')[0]}. Retrying once...`);
                    await new Promise(r => setTimeout(r, 1000));
                } else {
                    currentRpcIndex++;
                    if (currentRpcIndex < rpcUrls.length) {
                        console.warn(`[Utils] Switching to next RPC: ${rpcUrls[currentRpcIndex].split('//')[1]?.split('/')[0]}`);
                        provider = await getSafeProvider(currentRpcIndex);
                        if (!provider) continue; // Loop will handle next switch
                        attemptsPerRpc = 0;
                    } else {
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
