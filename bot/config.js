// ============================================================
//  CHAIN CONFIGURATION
//  All contract addresses for supported chains
// ============================================================

const CHAINS = {
  base: {
    name: "Base",
    chainId: 8453,
    aavePool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    uiDataProvider: "0x5c5228aC8BC1528482514aF3e27E692495148717",
    swapRouter: "0x2626664C2603336E57B271c5C0b26F421741e481",
    // Common tokens on Base
    tokens: {
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
      cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
      DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
    },
    // Uniswap V3 pool fee to try per pair (500 = 0.05%, 3000 = 0.3%)
    poolFees: {
      default: 500,
      fallback: 3000,
    }
  },

  arbitrum: {
    name: "Arbitrum One",
    chainId: 42161,
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    uiDataProvider: "0x69fa688f395726Bcc5019a2e37dC1aA3f8C95483",
    swapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    tokens: {
      USDC: { address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", decimals: 6 },
      USDC_e: { address: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", decimals: 6 },
      WETH: { address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", decimals: 18 },
      WBTC: { address: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8 },
      DAI: { address: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18 },
    },
    poolFees: {
      default: 500,
      fallback: 3000,
    }
  },

  polygon: {
    name: "Polygon",
    chainId: 137,
    aavePool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    uiDataProvider: "0xC69728F11E9e6127733751C8A3Aa03E27571C99C",
    swapRouter: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
    tokens: {
      USDC: { address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", decimals: 6 },
      WETH: { address: "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", decimals: 18 },
      WBTC: { address: "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", decimals: 8 },
      DAI: { address: "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", decimals: 18 },
      WMATIC: { address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", decimals: 18 },
    },
    poolFees: {
      default: 500,
      fallback: 3000,
    }
  }
};

// Aave V3 Pool ABI — only the functions we need
const AAVE_POOL_ABI = [
  "function getUserAccountData(address user) external view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
  "function getReservesList() external view returns (address[])",
  "function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt) data)"
];

// ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)"
];

// Your deployed contract ABI
const BOT_CONTRACT_ABI = [
  "function execute(address collateralAsset, address debtAsset, address userToLiquidate, uint256 debtToCover, uint24 poolFee, uint8 protocol, address protocolAddress) external",
  "function withdraw(address token) external",
  "function withdrawETH() external",
  "function getBalance(address token) external view returns (uint256)",
  "function owner() external view returns (address)"
];

const PROTOCOLS = {
  aaveV3: {
    name: "Aave V3",
    poolAddress: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    type: 0 // Enum: AAVE_V3
  },
  compoundV3: {
    name: "Compound V3",
    comet: "0xB12c13F66ade1f72F6d548316888c7F99056D688",
    type: 1 // COMPOUND_V3
  },
  moonwell: {
    name: "Moonwell",
    comptroller: "0xfBB213017a640c9789748671c35d396348FAfECC",
    type: 2, // MOONWELL
    mTokens: {
      USDC: "0xeDc90193f915788d5C05896029E979327D911195",
      WETH: "0x62839996EfA9d324C051383f5726266D03045bCD",
    }
  }
};

// aToken ABI (to read user's collateral/debt positions)
const ATOKEN_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function scaledBalanceOf(address user) external view returns (uint256)"
];

const CONTRACT_ADDRESS = "0xbfB83FD70B149DEF53591f50762Ed31c56Cb849E";

module.exports = { CONTRACT_ADDRESS, CHAINS, PROTOCOLS, AAVE_POOL_ABI, ERC20_ABI, BOT_CONTRACT_ABI, ATOKEN_ABI };
