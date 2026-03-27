# PROJECT_BRAIN — aave-liquidation-bot

## Project Summary
Flash-loan-funded liquidation bot targeting Aave V3, Compound V3, and Moonwell on Base. Monitors health factors, identifies undercollateralized positions, executes liquidations.

## Current State
- **Chain**: Base (8453) primary
- **Status**: Scanning users, finding targets, but liquidation execution was crashing (fixed 2026-03-27)

## Architecture
- `bot/config.js` — chain config, contract addresses, protocol settings
- `bot/protocols/AaveV3Adapter.js` — Aave V3 reserve data, health factor, liquidation logic
- `bot/protocols/CompoundV3Adapter.js` — Compound V3 adapter
- `bot/protocols/MoonwellAdapter.js` — Moonwell adapter
- Contract: `0x8C6c9F7F9DC99FEfD84bF8975B2f292ca8d0b579` (Base)

## Active Tasks
- Verify liquidation execution works after ethers v6 fix
- Monitor for successful liquidation of user 0x218d...

## Blockers
- None currently

## Decisions Log
| Date | Decision | Why |
|---|---|---|
| 2026-03-27 | Used defensive `(reserveData.data \|\| reserveData)` pattern | ethers.js v6 auto-unwraps single named returns — `.data` was undefined. Defensive pattern handles both v5 and v6. |

## Session Log

### 2026-03-27
**Done:**
1. Fixed `variableDebtTokenAddress` crash in AaveV3Adapter.js (lines 75, 95)
2. Root cause: ethers.js v6 auto-unwraps single named return values
3. Pushed to gitDivine/aave-liquidation-bot (master)

**Pending:**
- Confirm VPS restart picks up fix
- Verify liquidation of 0x218d... succeeds
- Check if Arbitrum liquidation config (`compoundV3: null`) causes issues

**Next:**
- Monitor VPS logs for successful liquidation execution
