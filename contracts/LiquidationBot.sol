// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  AAVE V3 LIQUIDATION BOT — SMART CONTRACT
//  Deploys on: Base, Arbitrum, Polygon
//  Author: Your Liquidation Bot
// ============================================================
//
//  HOW THIS CONTRACT WORKS:
//  1. Your off-chain bot detects an undercollateralized position
//  2. Bot calls execute() on this contract with target details
//  3. Contract requests a flash loan from Aave
//  4. In executeOperation(), contract liquidates the target position
//  5. Contract swaps received collateral back to debt token via Uniswap V3
//  6. Contract repays flash loan + 0.05% fee
//  7. Profit stays in contract — you withdraw anytime via withdraw()
//
// ============================================================

// ── Minimal Interfaces (no imports needed — self-contained) ──

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;

    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface ISwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        returns (uint256 amountOut);
}

// ── Main Contract ──────────────────────────────────────────

contract LiquidationBot {

    // ── State ─────────────────────────────────────────────
    address public owner;
    IPool   public immutable aavePool;
    ISwapRouter public immutable swapRouter;

    // Uniswap V3 pool fee tiers (try 0.05% first, fallback to 0.3%)
    uint24 public constant POOL_FEE_LOW    = 500;   // 0.05%
    uint24 public constant POOL_FEE_MEDIUM = 3000;  // 0.30%
    uint24 public constant POOL_FEE_HIGH   = 10000; // 1.00%

    // ── Events ────────────────────────────────────────────
    event LiquidationExecuted(
        address indexed user,
        address collateralAsset,
        address debtAsset,
        uint256 debtCovered,
        uint256 profit
    );
    event Withdrawn(address token, uint256 amount);

    // ── Modifiers ─────────────────────────────────────────
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ── Constructor ───────────────────────────────────────
    // Pass the Aave Pool address and Uniswap SwapRouter address for your chain
    // Base:     Aave = 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
    //           Uniswap = 0x2626664c2603336E57B271c5C0b26F421741e481
    // Arbitrum: Aave = 0x794a61358D6845594F94dc1DB02A252b5b4814aD
    //           Uniswap = 0xE592427A0AEce92De3Edee1F18E0157C05861564
    // Polygon:  Aave = 0x794a61358D6845594F94dc1DB02A252b5b4814aD
    //           Uniswap = 0xE592427A0AEce92De3Edee1F18E0157C05861564
    constructor(address _aavePool, address _swapRouter) {
        owner      = msg.sender;
        aavePool   = IPool(_aavePool);
        swapRouter = ISwapRouter(_swapRouter);
    }

    // Struct to pack our flash loan parameters to avoid "Stack too deep"
    struct FlashParams {
        address collateralAsset;
        address userToLiquidate;
        uint24 poolFee;
    }

    // ── ENTRY POINT — called by your off-chain bot ────────
    // @param collateralAsset  The token you will RECEIVE as liquidation bonus
    // @param debtAsset        The token you need to REPAY (flash loan this)
    // @param userToLiquidate  The underwater wallet address
    // @param debtToCover      Amount of debt to repay (use 0 for maximum = 50%)
    // @param poolFee          Uniswap pool fee: 500, 3000, or 10000
    function execute(
        address collateralAsset,
        address debtAsset,
        address userToLiquidate,
        uint256 debtToCover,
        uint24  poolFee
    ) external onlyOwner {
        // Pack all params to pass through the flash loan callback
        bytes memory params = abi.encode(
            FlashParams({
                collateralAsset: collateralAsset,
                userToLiquidate: userToLiquidate,
                poolFee: poolFee
            })
        );

        // Request flash loan of the debt asset from Aave
        // Aave sends funds → calls executeOperation() → expects repayment
        aavePool.flashLoanSimple(
            address(this),   // receiver = this contract
            debtAsset,       // asset to borrow
            debtToCover,     // amount to borrow
            params,          // data passed to executeOperation
            0                // referral code (0 = none)
        );
    }

    // ── FLASH LOAN CALLBACK — called by Aave ─────────────
    // Aave calls this automatically after sending the flash loan funds
    // MUST repay (amount + premium) before this function returns
    function executeOperation(
        address asset,         // the debt token we borrowed
        uint256 amount,        // how much we borrowed
        uint256 premium,       // flash loan fee (0.05%)
        address,               // initiator (unused)
        bytes calldata params  // our packed data
    ) external returns (bool) {
        // Only Aave pool can call this
        require(msg.sender == address(aavePool), "Caller not Aave Pool");

        // Unpack our parameters directly into memory struct to save stack space
        FlashParams memory decoded = abi.decode(params, (FlashParams));

        // ── Step 1: Approve Aave to take the debt repayment ──
        IERC20(asset).approve(address(aavePool), amount);

        // ── Step 2: Liquidate the unhealthy position ──────────
        // We repay their debt, we receive their collateral at a discount
        aavePool.liquidationCall(
            decoded.collateralAsset,   // collateral we want to receive
            asset,                     // debt token we are repaying
            decoded.userToLiquidate,   // the user being liquidated
            amount,                    // repay the full flash loan amount
            false                      // false = receive underlying token (not aToken)
        );

        // ── Step 3: Swap received collateral → debt token ────
        uint256 amountOwed = amount + premium; // repay loan + fee

        if (decoded.collateralAsset != asset) {
            uint256 collateralBalance = IERC20(decoded.collateralAsset).balanceOf(address(this));
            
            // Approve Uniswap to spend our collateral
            IERC20(decoded.collateralAsset).approve(address(swapRouter), collateralBalance);

            // Swap collateral for debt token
            // amountOutMinimum = amountOwed ensures we at least break even
            ISwapRouter.ExactInputSingleParams memory swapParams =
                ISwapRouter.ExactInputSingleParams({
                    tokenIn:           decoded.collateralAsset,
                    tokenOut:          asset,
                    fee:               decoded.poolFee,
                    recipient:         address(this),
                    deadline:          block.timestamp + 300, // 5 min max
                    amountIn:          collateralBalance,
                    amountOutMinimum:  amountOwed,           // slippage protection
                    sqrtPriceLimitX96: 0
                });

            swapRouter.exactInputSingle(swapParams);
        }

        // ── Step 4: Approve Aave to pull back loan + fee ─────
        uint256 debtBalance = IERC20(asset).balanceOf(address(this));
        require(debtBalance >= amountOwed, "Insufficient funds to repay");
        
        // Approve aavePool to pull the specific amount owed
        IERC20(asset).approve(address(aavePool), amountOwed);

        // Calculate profit for the event log
        uint256 profit = debtBalance - amountOwed;

        emit LiquidationExecuted(
            decoded.userToLiquidate,
            decoded.collateralAsset,
            asset,
            amount,
            profit
        );

        return true; // Aave pulls repayment automatically after this returns
    }

    // ── WITHDRAW PROFITS ──────────────────────────────────
    // Call this anytime to move profits from contract to your wallet
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Nothing to withdraw");
        IERC20(token).transfer(owner, balance);
        emit Withdrawn(token, balance);
    }

    // Withdraw native ETH (for any accidentally sent ETH)
    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No ETH to withdraw");
        (bool success, ) = owner.call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    // ── VIEW — check contract's profit balance ────────────
    function getBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    // ── SAFETY — transfer ownership ───────────────────────
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }

    // Accept ETH
    receive() external payable {}
}
