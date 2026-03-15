// scripts/deploy_v2.js — Multi-Chain Deployment for LiquidationBot.sol
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { CHAINS } = require('../bot/config');

const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const ALCHEMY_URL = process.env.ALCHEMY_HTTP_URL || '';
const CHAIN = process.env.CHAIN || 'base';

const chainConfig = CHAINS[CHAIN];

async function main() {
    console.log(`\n🚀 Deploying LiquidationBot to ${chainConfig.name}...`);
    
    // 1. Compile
    const solc = require('solc');
    const contractPath = path.resolve(__dirname, '..', 'contracts', 'LiquidationBot.sol');
    const source = fs.readFileSync(contractPath, 'utf8');

    const input = {
        language: 'Solidity',
        sources: { 'LiquidationBot.sol': { content: source } },
        settings: {
            optimizer: { enabled: true, runs: 200 },
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
    };

    function findImports(importPath) {
        if (importPath.startsWith('@openzeppelin/')) {
            const absolutePath = path.resolve(__dirname, '..', 'node_modules', importPath);
            return { contents: fs.readFileSync(absolutePath, 'utf8') };
        }
        return { error: 'File not found' };
    }

    const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
    const compiled = output.contracts['LiquidationBot.sol']['LiquidationBot'];
    const { abi, evm: { bytecode: { object: bytecode } } } = compiled;

    // 2. Deploy
    const provider = new ethers.JsonRpcProvider(ALCHEMY_URL, chainConfig.chainId, { staticNetwork: true });
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    
    console.log(`📍 Deployer: ${signer.address}`);
    const factory = new ethers.ContractFactory(abi, bytecode, signer);
    
    const aavePool = chainConfig.aavePool;
    const swapRouter = chainConfig.swapRouter;
    
    console.log(`📋 Constructor Args:\n   Pool: ${aavePool}\n   Router: ${swapRouter}`);

    const contract = await factory.deploy(aavePool, swapRouter);
    await contract.waitForDeployment();
    
    const address = await contract.getAddress();
    console.log(`✅ Deployed at: ${address}`);

    // 3. Update .env if same chain
    const envPath = path.resolve(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (CHAIN === (process.env.CHAIN || 'base')) {
        if (envContent.includes('CONTRACT_ADDRESS=')) {
            envContent = envContent.replace(/CONTRACT_ADDRESS=.*/, `CONTRACT_ADDRESS=${address}`);
        } else {
            envContent += `\nCONTRACT_ADDRESS=${address}\n`;
        }
        fs.writeFileSync(envPath, envContent);
        console.log('✅ Local .env updated.');
    } else {
        console.log(`\nCopy this to your Arbitrum folder's .env:`);
        console.log(`CONTRACT_ADDRESS=${address}`);
    }
}

main().catch(e => console.error(`❌ Failed: ${e.message}`));
