// scripts/deploy.js — Compile & deploy LiquidationBot.sol
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { CHAINS } = require('../bot/config');

const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const RPC_URL = process.env.ALCHEMY_HTTP_URL || '';
const CHAIN = process.env.CHAIN || 'base';

if (!PRIVATE_KEY || PRIVATE_KEY === 'your_private_key_here') {
    console.error('❌ Set PRIVATE_KEY in your .env file first');
    process.exit(1);
}
if (!RPC_URL || RPC_URL.includes('YOUR_API_KEY_HERE')) {
    console.error('❌ Set ALCHEMY_HTTP_URL in your .env file first');
    process.exit(1);
}

const chainConfig = CHAINS[CHAIN];
if (!chainConfig) {
    console.error(`❌ Unknown chain "${CHAIN}". Supported: base, arbitrum, polygon`);
    process.exit(1);
}

async function main() {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log('  ║   LiquidationBot.sol — Deploy to ' + chainConfig.name.padEnd(10) + '  ║');
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    // ── 1. Compile LiquidationBot.sol ─────────────────────────
    console.log('⏳ Compiling LiquidationBot.sol...');

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

    if (output.errors) {
        const fatal = output.errors.filter(e => e.severity === 'error');
        if (fatal.length > 0) {
            console.error('❌ Compilation failed:');
            fatal.forEach(e => console.error(e.formattedMessage));
            process.exit(1);
        }
        output.errors
            .filter(e => e.severity === 'warning')
            .forEach(e => console.warn('⚠️', e.message));
    }

    const compiled = output.contracts['LiquidationBot.sol']['LiquidationBot'];
    const abi = compiled.abi;
    const bytecode = '0x' + compiled.evm.bytecode.object;

    if (!bytecode || bytecode === '0x') {
        console.error('❌ Compilation produced empty bytecode.');
        process.exit(1);
    }

    console.log('✅ Compiled successfully');

    // ── 2. Deploy ─────────────────────────────────────────────
    const provider = new ethers.JsonRpcProvider(RPC_URL, chainConfig.chainId, { staticNetwork: true });
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);

    const balance = await provider.getBalance(signer.address);
    const ethBalance = Number(ethers.formatEther(balance));

    console.log(`📍 Chain: ${chainConfig.name}`);
    console.log(`📍 Deployer: ${signer.address}`);
    console.log(`💰 ETH Balance: ${ethBalance.toFixed(4)}`);

    if (ethBalance < 0.001) {
        console.error('❌ Not enough ETH for gas. Need at least 0.001 ETH.');
        process.exit(1);
    }

    const aavePool = ethers.getAddress(chainConfig.aavePool.toLowerCase());
    const swapRouter = ethers.getAddress(chainConfig.swapRouter.toLowerCase());

    console.log(`📋 Constructor args:`);
    console.log(`   _aavePool:   ${aavePool}`);
    console.log(`   _swapRouter: ${swapRouter}`);
    console.log('');
    console.log('⏳ Deploying...');

    const factory = new ethers.ContractFactory(abi, bytecode, signer);
    const contract = await factory.deploy(aavePool, swapRouter);
    await contract.waitForDeployment();

    const contractAddress = await contract.getAddress();

    console.log('');
    console.log('  ╔══════════════════════════════════════════════╗');
    console.log(`  ║ ✅ Deployed: ${contractAddress}  ║`);
    console.log('  ╚══════════════════════════════════════════════╝');
    console.log('');

    // ── 3. Auto-update .env ───────────────────────────────────
    const envPath = path.resolve(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    if (envContent.includes('CONTRACT_ADDRESS=')) {
        envContent = envContent.replace(
            /CONTRACT_ADDRESS=.*/,
            `CONTRACT_ADDRESS=${contractAddress}`
        );
    } else {
        envContent += `\nCONTRACT_ADDRESS=${contractAddress}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    console.log('✅ CONTRACT_ADDRESS updated in .env');
    console.log('');
    console.log('🚀 Start the bot with: npm start');
    console.log('');
}

main().catch(err => {
    console.error('❌ Deploy failed:', err.message);
    process.exit(1);
});
