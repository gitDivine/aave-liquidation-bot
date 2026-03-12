// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title LiquidationBot
 * @notice Multi-protocol liquidation bot using Aave V3 Flash Loans.
 * Supports: Aave V3, Compound V3, Moonwell.
 */

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IPool {
    function flashLoanSimple(address receiverAddress, address asset, uint256 amount, bytes calldata params, uint16 referralCode) external;
    function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external;
}

interface IComet {
    function absorb(address[] calldata accounts) external;
    function buyCollateral(address asset, uint minAmount, uint baseAmount, address recipient) external;
    function baseToken() external view returns (address);
}

interface IComptroller {
    function liquidateBorrow(address borrower, uint repayAmount, address cTokenCollateral) external returns (uint);
}

interface ICToken {
    function redeem(uint redeemTokens) external returns (uint);
    function balanceOf(address owner) external view returns (uint);
    function underlying() external view returns (address);
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
    function exactInputSingle(ExactInputSingleParams calldata params) external returns (uint256 amountOut);
}

contract LiquidationBot {
    // --- State Variables ---
    address public owner;
    IPool public immutable aavePool;
    ISwapRouter public immutable swapRouter;

    enum ProtocolType { AAVE_V3, COMPOUND_V3, MOONWELL }

    struct FlashParams {
        address collateralAsset;
        address userToLiquidate;
        uint24 poolFee;
        ProtocolType protocol;
        address protocolAddress;
    }

    // --- Events ---
    event LiquidationExecuted(address indexed user, address collat, address debt, uint256 profit, ProtocolType protocol);

    // --- Modifiers ---
    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // --- Constructor ---
    constructor(address _aavePool, address _swapRouter) {
        owner = msg.sender;
        aavePool = IPool(_aavePool);
        swapRouter = ISwapRouter(_swapRouter);
    }

    // --- Entry Point ---
    function execute(
        address collateralAsset,
        address debtAsset,
        address userToLiquidate,
        uint256 debtToCover,
        uint24 poolFee,
        ProtocolType protocol,
        address protocolAddress
    ) external onlyOwner {
        bytes memory params = abi.encode(FlashParams({
            collateralAsset: collateralAsset,
            userToLiquidate: userToLiquidate,
            poolFee: poolFee,
            protocol: protocol,
            protocolAddress: protocolAddress
        }));

        aavePool.flashLoanSimple(address(this), debtAsset, debtToCover, params, 0);
    }

    // --- Flash Loan Callback ---
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator, // Named parameter to avoid ambiguity
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(aavePool), "Untrusted");
        require(initiator == address(this), "Foreign FlashLoan");

        FlashParams memory decoded = abi.decode(params, (FlashParams));
        uint256 amountOwed = amount + premium;

        // --- Step 1: Protocol Specific Liquidation ---
        IERC20(asset).approve(decoded.protocolAddress, amount);

        if (decoded.protocol == ProtocolType.AAVE_V3) {
            aavePool.liquidationCall(decoded.collateralAsset, asset, decoded.userToLiquidate, amount, false);
        } 
        else if (decoded.protocol == ProtocolType.COMPOUND_V3) {
            address[] memory users = new address[](1);
            users[0] = decoded.userToLiquidate;
            IComet(decoded.protocolAddress).absorb(users);
            IComet(decoded.protocolAddress).buyCollateral(decoded.collateralAsset, 0, amount, address(this));
        }
        else if (decoded.protocol == ProtocolType.MOONWELL) {
            IComptroller(decoded.protocolAddress).liquidateBorrow(decoded.userToLiquidate, amount, decoded.collateralAsset);
            uint256 cBal = ICToken(decoded.collateralAsset).balanceOf(address(this));
            ICToken(decoded.collateralAsset).redeem(cBal);
        }

        // --- Step 2: Extract Net Collateral ---
        address actualCollateral = (decoded.protocol == ProtocolType.MOONWELL) 
            ? ICToken(decoded.collateralAsset).underlying() 
            : decoded.collateralAsset;

        // --- Step 3: Swap back to clear debt ---
        if (actualCollateral != asset) {
            uint256 bal = IERC20(actualCollateral).balanceOf(address(this));
            IERC20(actualCollateral).approve(address(swapRouter), bal);
            
            swapRouter.exactInputSingle(ISwapRouter.ExactInputSingleParams({
                tokenIn: actualCollateral,
                tokenOut: asset,
                fee: decoded.poolFee,
                recipient: address(this),
                deadline: block.timestamp + 300,
                amountIn: bal,
                amountOutMinimum: amountOwed,
                sqrtPriceLimitX96: 0
            }));
        }

        // --- Step 4: Final Repayment Check ---
        uint256 finalBal = IERC20(asset).balanceOf(address(this));
        require(finalBal >= amountOwed, "Insolvent");
        IERC20(asset).approve(address(aavePool), amountOwed);

        emit LiquidationExecuted(decoded.userToLiquidate, actualCollateral, asset, finalBal - amountOwed, decoded.protocol);
        return true;
    }

    // --- Admin Functions ---
    function withdraw(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance > 0, "Nothing");
        IERC20(token).transfer(owner, balance);
    }

    function withdrawETH() external onlyOwner {
        uint256 balance = address(this).balance;
        (bool success, ) = payable(owner).call{value: balance}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
