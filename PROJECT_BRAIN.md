# PROJECT_BRAIN — aave-liquidation-bot

## Project Summary
Flash-loan-funded liquidation bot targeting Aave V3, Compound V3, and Moonwell. Monitors health factors, identifies undercollateralized positions, executes flash-loan-funded liquidations.

## Current State
- **Base (8453)**: Running, scanning, triage active. ethers v6 fix applied.
- **Arbitrum (42161)**: Contract deployed 2026-03-28. Needs VPS .env update.
- **Status**: Pool fee fix + gas guard applied. Ready for live liquidation attempts.

## Architecture
- `bot/config.js` — chain config, contract addresses, protocol settings
- `bot/bot.js` — main loop, triage, liquidation execution, simulation
- `bot/protocols/AaveV3Adapter.js` — Aave V3 reserve data, health factor, liquidation logic
- `bot/protocols/CompoundV3Adapter.js` — Compound V3 adapter
- `bot/protocols/MoonwellAdapter.js` — Moonwell adapter
- `contracts/LiquidationBot.sol` — on-chain flash loan liquidation executor
- `scripts/deploy_v2.js` — multi-chain deployment script

## Deployed Contracts
| Chain | Address | Aave Pool | Swap Router |
|---|---|---|---|
| Base | `0x8C6c9F7F9DC99FEfD84bF8975B2f292ca8d0b579` | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` | `0x2626664C2603336E57B271c5C0b26F421741e481` |
| Arbitrum | `0x5BeE00F8607f42c5E3Fb36353Da1030fC8a9C285` | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` | `0xE592427A0AEce92De3Edee1F18E0157C05861564` |

## Active Tasks
- Update VPS Arbitrum liquidation bot .env with new CONTRACT_ADDRESS
- Monitor for first successful liquidation on either chain

## Blockers
- None

## Decisions Log
| Date | Decision | Why |
|---|---|---|
| 2026-03-27 | Defensive `(reserveData.data \|\| reserveData)` pattern | ethers.js v6 auto-unwraps single named returns |
| 2026-03-28 | Pool fee: config-driven (500 default, 3000 fallback) | Was hardcoded to 3000 — 500 (0.05%) pools have better liquidity |
| 2026-03-28 | Wired up MAX_GAS_GWEI guard | Was parsed but never checked — prevents gas waste |
| 2026-03-28 | Deployed LiquidationBot to Arbitrum | Constructor hardcodes aavePool + swapRouter — Base contract cannot work on Arbitrum |

## Session Log

### 2026-03-27
**Done:**
1. Fixed `variableDebtTokenAddress` crash in AaveV3Adapter.js (lines 75, 95)
2. Root cause: ethers.js v6 auto-unwraps single named return values

### 2026-03-28
**Done:**
1. Fixed pool fee: hardcoded 3000 → config-driven (500 default, 3000 fallback), tries both via simulation
2. Wired up MAX_GAS_GWEI guard — skips if gas too high
3. Deployed LiquidationBot.sol to Arbitrum: `0x5BeE00F8607f42c5E3Fb36353Da1030fC8a9C285`
4. Verified owner, aavePool, swapRouter on-chain — all correct

**Pending:**
- Update VPS Arbitrum .env: `CONTRACT_ADDRESS=0x5BeE00F8607f42c5E3Fb36353Da1030fC8a9C285`
- Restart Arbitrum liquidation bot on VPS
- Monitor for first successful liquidation

**Next:**
- User updates VPS .env and restarts
