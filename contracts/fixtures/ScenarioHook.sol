// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// @notice Composite fixture that exposes callback, direction, fee and sequence
/// mechanics through a real PoolManager execution context.
contract ScenarioHook is BaseHook {
    using PoolIdLibrary for PoolKey;

    error DirectionUnavailable();
    error RouterUnavailable(address router);
    error PoolUnavailable(PoolId poolId);
    error CallbackSequenceIncomplete();

    struct Counts {
        uint64 beforeAddLiquidity;
        uint64 afterAddLiquidity;
        uint64 beforeRemoveLiquidity;
        uint64 afterRemoveLiquidity;
        uint64 beforeSwap;
        uint64 afterSwap;
        uint64 beforeDonate;
        uint64 afterDonate;
    }

    mapping(PoolId poolId => Counts counts) internal _counts;
    bool public zeroForOneUnavailable;
    bool public configurationRestricted;
    bool public poolRestricted;
    address public allowedRouter;
    address public lastRouter;
    address public lastParticipant;
    uint24 public swapFee;
    int128 public beforeSwapSpecifiedDelta;
    int128 public afterSwapUnspecifiedDelta;
    int128 public afterLiquidityAmount0;
    int128 public afterLiquidityAmount1;
    PoolId public allowedPool;
    address public immutable configurationAdmin;

    constructor(IPoolManager manager, address admin) BaseHook(manager) {
        configurationAdmin = admin;
    }

    // Tests etch the deployed runtime to an address whose low bits match the
    // callback bitmap, exactly as Uniswap's own hook fixtures do.
    function validateHookAddress(BaseHook) internal pure override {}

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: false,
            beforeAddLiquidity: true,
            afterAddLiquidity: true,
            beforeRemoveLiquidity: true,
            afterRemoveLiquidity: true,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: true,
            afterDonate: true,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: true,
            afterRemoveLiquidityReturnDelta: true
        });
    }

    function configureDirection(bool unavailable) external {
        zeroForOneUnavailable = unavailable;
    }

    function configureRouter(address router) external {
        if (configurationRestricted) require(msg.sender == configurationAdmin, "admin");
        allowedRouter = router;
    }

    function configurePolicy(bool restricted) external {
        require(msg.sender == configurationAdmin, "admin");
        configurationRestricted = restricted;
    }

    function configurePoolPolicy(PoolId poolId, bool restricted) external {
        require(msg.sender == configurationAdmin, "admin");
        allowedPool = poolId;
        poolRestricted = restricted;
    }

    function configureSwapFee(uint24 fee) external {
        require(fee <= LPFeeLibrary.MAX_LP_FEE, "fee");
        swapFee = fee;
    }

    /// @notice Configures small positive return deltas for deterministic
    /// PoolManager accounting checks. The callbacks take the matching amounts
    /// so PoolManager's unlock invariant remains balanced.
    function configureReturnDeltas(
        int128 specified,
        int128 afterSwap,
        int128 liquidityAmount0,
        int128 liquidityAmount1
    ) external {
        require(
            specified >= 0 && afterSwap >= 0 && liquidityAmount0 >= 0 && liquidityAmount1 >= 0,
            "positive fixture deltas only"
        );
        beforeSwapSpecifiedDelta = specified;
        afterSwapUnspecifiedDelta = afterSwap;
        afterLiquidityAmount0 = liquidityAmount0;
        afterLiquidityAmount1 = liquidityAmount1;
    }

    function counts(PoolId poolId) external view returns (Counts memory) {
        return _counts[poolId];
    }

    function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        _counts[key.toId()].beforeAddLiquidity++;
        return BaseHook.beforeAddLiquidity.selector;
    }

    function _beforeRemoveLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        _counts[key.toId()].beforeRemoveLiquidity++;
        return BaseHook.beforeRemoveLiquidity.selector;
    }

    function _afterAddLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, BalanceDelta) {
        _counts[key.toId()].afterAddLiquidity++;
        return (BaseHook.afterAddLiquidity.selector, _takeLiquidityDelta(key));
    }

    function _afterRemoveLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) internal override returns (bytes4, BalanceDelta) {
        _counts[key.toId()].afterRemoveLiquidity++;
        return (BaseHook.afterRemoveLiquidity.selector, _takeLiquidityDelta(key));
    }

    function _beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (allowedRouter != address(0) && sender != allowedRouter) revert RouterUnavailable(sender);
        if (poolRestricted && PoolId.unwrap(key.toId()) != PoolId.unwrap(allowedPool)) {
            revert PoolUnavailable(key.toId());
        }
        if (zeroForOneUnavailable && params.zeroForOne) revert DirectionUnavailable();

        _counts[key.toId()].beforeSwap++;
        lastRouter = sender;
        if (hookData.length == 32) lastParticipant = abi.decode(hookData, (address));
        assembly ("memory-safe") {
            tstore(0, 1)
        }

        int128 specifiedDelta = beforeSwapSpecifiedDelta;
        if (specifiedDelta > 0) {
            Currency specifiedCurrency = params.zeroForOne == (params.amountSpecified < 0)
                ? key.currency0
                : key.currency1;
            poolManager.take(specifiedCurrency, address(this), uint128(specifiedDelta));
        }

        uint24 feeOverride = swapFee == 0 ? 0 : swapFee | LPFeeLibrary.OVERRIDE_FEE_FLAG;
        BeforeSwapDelta hookDelta = specifiedDelta == 0
            ? BeforeSwapDeltaLibrary.ZERO_DELTA
            : toBeforeSwapDelta(specifiedDelta, 0);
        return (BaseHook.beforeSwap.selector, hookDelta, feeOverride);
    }

    function _afterSwap(address, PoolKey calldata key, SwapParams calldata params, BalanceDelta, bytes calldata)
        internal
        override
        returns (bytes4, int128)
    {
        uint256 active;
        assembly ("memory-safe") {
            active := tload(0)
        }
        if (active != 1) revert CallbackSequenceIncomplete();
        _counts[key.toId()].afterSwap++;
        int128 unspecifiedDelta = afterSwapUnspecifiedDelta;
        if (unspecifiedDelta > 0) {
            Currency unspecifiedCurrency = params.zeroForOne == (params.amountSpecified < 0)
                ? key.currency1
                : key.currency0;
            poolManager.take(unspecifiedCurrency, address(this), uint128(unspecifiedDelta));
        }
        return (BaseHook.afterSwap.selector, unspecifiedDelta);
    }

    function _beforeDonate(address, PoolKey calldata key, uint256, uint256, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        _counts[key.toId()].beforeDonate++;
        return BaseHook.beforeDonate.selector;
    }

    function _afterDonate(address, PoolKey calldata key, uint256, uint256, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        _counts[key.toId()].afterDonate++;
        return BaseHook.afterDonate.selector;
    }

    function _takeLiquidityDelta(PoolKey calldata key) internal returns (BalanceDelta) {
        int128 amount0 = afterLiquidityAmount0;
        int128 amount1 = afterLiquidityAmount1;
        if (amount0 > 0) poolManager.take(key.currency0, address(this), uint128(amount0));
        if (amount1 > 0) poolManager.take(key.currency1, address(this), uint128(amount1));
        return toBalanceDelta(amount0, amount1);
    }
}
